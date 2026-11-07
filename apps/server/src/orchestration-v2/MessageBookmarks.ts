import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import {
  MessageBookmark,
  MessageBookmarkError,
  SavedMessageBookmark,
  type MessageBookmarkAddInput,
  type MessageBookmarkRef,
  type MessageBookmarkRefRenameInput,
  type MessageBookmarksInput,
  type MessageBookmarkWithExchange,
  type OrchestrationV2ConversationMessage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { messageBookmarkTitle } from "@t3tools/shared/messageBookmarkTitle";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export class MessageBookmarks extends Context.Service<
  MessageBookmarks,
  {
    /** Whole-message bookmarks only: the list agent tools read. */
    readonly list: (
      input: MessageBookmarksInput,
    ) => Effect.Effect<readonly MessageBookmark[], MessageBookmarkError>;
    /** Every bookmark in the chat, oldest first: whole messages, text selections, and pages. */
    readonly listSaved: (
      input: MessageBookmarksInput,
    ) => Effect.Effect<readonly SavedMessageBookmark[], MessageBookmarkError>;
    readonly listWithExchanges: (
      input: MessageBookmarksInput,
    ) => Effect.Effect<readonly MessageBookmarkWithExchange[], MessageBookmarkError>;
    readonly subscribe: (
      input: MessageBookmarksInput,
    ) => Stream.Stream<readonly SavedMessageBookmark[], MessageBookmarkError>;
    readonly add: (input: MessageBookmarkAddInput) => Effect.Effect<void, MessageBookmarkError>;
    readonly rename: (
      input: MessageBookmarkRefRenameInput,
    ) => Effect.Effect<void, MessageBookmarkError>;
    readonly remove: (input: MessageBookmarkRef) => Effect.Effect<void, MessageBookmarkError>;
  }
>()("t3/orchestration-v2/MessageBookmarks") {}

type SavedTarget = SavedMessageBookmark["target"];
const decodeSavedBookmark = Schema.decodeEffect(SavedMessageBookmark);
const ExcerptTarget = SavedMessageBookmark.fields.target;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Not numbered migrations: this fork shares databases with official builds,
  // which would record their own migration under the same id.
  yield* sql`
    CREATE TABLE IF NOT EXISTS message_bookmarks (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      run_id TEXT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      generation_id TEXT,
      PRIMARY KEY (thread_id, message_id)
    ) WITHOUT ROWID
  `;
  // Text and page bookmarks live apart so whole-message rows, which agent tools and earlier
  // builds of this fork read by message id, keep their original table and shape.
  yield* sql`
    CREATE TABLE IF NOT EXISTS message_bookmark_excerpts (
      thread_id TEXT NOT NULL,
      bookmark_id TEXT NOT NULL,
      run_id TEXT,
      target_json TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      generation_id TEXT,
      PRIMARY KEY (thread_id, bookmark_id)
    ) WITHOUT ROWID
  `;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<string>();
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const generation = yield* TextGeneration.TextGeneration;
  const storageError = (cause: unknown) => new MessageBookmarkError({ reason: "storage", cause });
  const decode = Schema.decodeUnknownEffect(Schema.Array(MessageBookmark));
  const decodeExcerptTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(ExcerptTarget));
  const encodeExcerptTarget = Schema.encodeEffect(Schema.fromJsonString(ExcerptTarget));
  // Deleted threads are inaccessible even if their bookmark rows remain for recovery.
  const ensureThreadAvailable = Effect.fn("MessageBookmarks.ensureThreadAvailable")(function* (
    threadId: MessageBookmarksInput["threadId"],
  ) {
    const records = yield* projections
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError(storageError));
    if (records.thread.deletedAt !== null)
      return yield* new MessageBookmarkError({ reason: "message-not-found" });
  });
  const turnCompletion = (threadId: ThreadId) =>
    projections.getVisibleTurnCompletion(threadId).pipe(Effect.mapError(storageError));
  // Undoing a turn hides its messages but keeps their bookmark rows. Bookmarks on turns that
  // were stopped or failed stay hidden the same way.
  const shown = (
    completion: Effect.Success<ReturnType<typeof turnCompletion>>,
    target: SavedTarget,
  ) =>
    target.type === "page"
      ? completion.items.get(target.itemId)?.completed === true
      : completion.messages.get(target.messageId) === true;

  const readWholeMessageBookmarks = (threadId: ThreadId) =>
    sql`
      SELECT thread_id AS "threadId", message_id AS "messageId", run_id AS "runId",
        title, created_at AS "createdAt"
      FROM message_bookmarks WHERE thread_id = ${threadId}
      ORDER BY created_at, message_id
    `.pipe(
      Effect.mapError(storageError),
      Effect.flatMap((rows) => decode(rows).pipe(Effect.mapError(storageError))),
    );

  const list: MessageBookmarks["Service"]["list"] = Effect.fn("MessageBookmarks.list")(
    function* (input) {
      yield* ensureThreadAvailable(input.threadId);
      const bookmarks = yield* readWholeMessageBookmarks(input.threadId);
      const completion = yield* turnCompletion(input.threadId);
      return bookmarks.filter((bookmark) =>
        shown(completion, { type: "message", messageId: bookmark.messageId }),
      );
    },
  );

  const listSaved: MessageBookmarks["Service"]["listSaved"] = Effect.fn(
    "MessageBookmarks.listSaved",
  )(function* (input) {
    yield* ensureThreadAvailable(input.threadId);
    const wholeMessages = (yield* readWholeMessageBookmarks(input.threadId)).map(
      (bookmark): SavedMessageBookmark => ({
        id: bookmark.messageId,
        threadId: bookmark.threadId,
        runId: bookmark.runId,
        title: bookmark.title,
        createdAt: bookmark.createdAt,
        target: { type: "message", messageId: bookmark.messageId },
      }),
    );
    const excerptRows = yield* sql<{
      bookmarkId: string;
      runId: string | null;
      targetJson: string;
      title: string;
      createdAt: string;
    }>`
      SELECT bookmark_id AS "bookmarkId", run_id AS "runId", target_json AS "targetJson",
        title, created_at AS "createdAt"
      FROM message_bookmark_excerpts WHERE thread_id = ${input.threadId}
    `.pipe(Effect.mapError(storageError));
    const excerpts = yield* Effect.forEach(excerptRows, (row) =>
      decodeExcerptTarget(row.targetJson).pipe(
        Effect.flatMap((target) =>
          decodeSavedBookmark({
            id: row.bookmarkId,
            threadId: input.threadId,
            runId: row.runId,
            title: row.title,
            createdAt: row.createdAt,
            target,
          }),
        ),
        Effect.mapError(storageError),
      ),
    );
    const completion = yield* turnCompletion(input.threadId);
    return [...wholeMessages, ...excerpts]
      .filter((bookmark) => shown(completion, bookmark.target))
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
  });

  const listWithExchanges: MessageBookmarks["Service"]["listWithExchanges"] = Effect.fn(
    "MessageBookmarks.listWithExchanges",
  )(function* (input) {
    const bookmarks = yield* list(input);
    if (bookmarks.length === 0) return [];
    const exchanges = yield* projections
      .getMessageExchanges(
        input.threadId,
        bookmarks.map((bookmark) => bookmark.messageId),
      )
      .pipe(Effect.mapError(storageError));
    return bookmarks.flatMap((bookmark) => {
      const items = exchanges.get(bookmark.messageId);
      if (!items) return [];
      const entries = items.flatMap((item): MessageBookmarkWithExchange["entries"] => {
        const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
        if (item.type === "dynamic_tool") {
          const htmlRender = htmlRenderFromToolItem(item);
          return htmlRender ? [{ type: "page", itemId: item.id, htmlRender, createdAt }] : [];
        }
        if (item.type !== "user_message" && item.type !== "assistant_message") return [];
        return [
          {
            type: "message",
            messageId: item.messageId,
            role: item.type === "user_message" ? "user" : "assistant",
            text: item.text,
            attachments: (item.attachments ?? []).map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
            })),
            createdAt,
          },
        ];
      });
      return [{ bookmarkId: bookmark.messageId, entries }];
    });
  });

  // Persist first. Losing the connection or a model failure must never lose the bookmark, so the
  // model's title replaces the saved fallback later, unless a rename, removal, or re-add came first.
  const generateTitleLater = Effect.fn("MessageBookmarks.generateTitleLater")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly text: string;
      readonly fallbackTitle: string;
      readonly save: (title: string) => Effect.Effect<void, MessageBookmarkError>;
    }) {
      const generated = yield* Effect.gen(function* () {
        const project = yield* projects.get(input.projectId);
        if (Option.isNone(project)) return null;
        const resolved = resolveProjectSettings(
          yield* settings.getSettings,
          input.projectId,
        ).settings;
        const result = yield* generation.generateThreadTitle({
          cwd: input.worktreePath ?? project.value.workspaceRoot,
          message: input.text.trim() ? input.text.slice(0, 12_000) : input.fallbackTitle,
          attachments: [],
          linkedContext: "",
          modelSelection: resolved.textGenerationModelSelection,
        });
        const value = result.title.trim().slice(0, 160).trim();
        return value && value !== "New thread" ? value : null;
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.orElseSucceed(() => null),
      );
      if (!generated) return;
      yield* input.save(generated);
    },
    (effect) => effect.pipe(Effect.ignore, Effect.forkIn(serviceScope)),
  );

  const findMessage = Effect.fn("MessageBookmarks.findMessage")(function* (
    threadId: ThreadId,
    messageId: OrchestrationV2ConversationMessage["id"],
  ) {
    const projection = yield* projections
      .getThreadRecords(threadId, ["messages"], { messageIds: [messageId] })
      .pipe(Effect.mapError(storageError));
    if (projection.thread.deletedAt !== null)
      return yield* new MessageBookmarkError({ reason: "message-not-found" });
    let message:
      | Pick<OrchestrationV2ConversationMessage, "role" | "text" | "attachments" | "runId">
      | undefined = projection.messages.find((candidate) => candidate.id === messageId);
    if (!message) {
      // A fork keeps inherited messages in their source thread. Read through the
      // visible index so a message beyond the fork boundary cannot be bookmarked.
      const page = yield* projections
        .getTimelinePage(threadId, { messageId, limit: 1 })
        .pipe(Effect.mapError(storageError));
      const item = page.items[0]?.item;
      if (item?.type === "user_message" || item?.type === "assistant_message") {
        message = {
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          runId: item.runId,
          attachments: item.type === "user_message" ? item.attachments : [],
        };
      }
    }
    if (!message || (message.role !== "user" && message.role !== "assistant"))
      return yield* new MessageBookmarkError({ reason: "message-not-found" });
    return { thread: projection.thread, message };
  });

  const ensureTurnCompleted = (completed: boolean | undefined) =>
    completed === undefined
      ? new MessageBookmarkError({ reason: "message-not-found" })
      : completed
        ? Effect.void
        : new MessageBookmarkError({ reason: "turn-not-completed" });

  const addWholeMessage = Effect.fn("MessageBookmarks.addWholeMessage")(function* (
    threadId: ThreadId,
    messageId: OrchestrationV2ConversationMessage["id"],
  ) {
    const { thread, message } = yield* findMessage(threadId, messageId);
    const completion = yield* turnCompletion(threadId);
    yield* ensureTurnCompleted(completion.messages.get(messageId));
    const title = messageBookmarkTitle(message.text, message.attachments[0]?.name);
    const generationId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError));
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* sql`
      INSERT INTO message_bookmarks (thread_id, message_id, run_id, title, created_at, generation_id)
      VALUES (${threadId}, ${messageId}, ${message.runId}, ${title}, ${createdAt}, ${generationId})
      ON CONFLICT (thread_id, message_id) DO NOTHING RETURNING message_id
    `.pipe(Effect.mapError(storageError));
    if (inserted.length === 0) return;
    yield* PubSub.publish(changes, threadId);
    yield* generateTitleLater({
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      text: message.text,
      fallbackTitle: title,
      save: (generated) =>
        sql`
          UPDATE message_bookmarks SET title = ${generated}, generation_id = NULL
          WHERE thread_id = ${threadId} AND message_id = ${messageId}
            AND generation_id = ${generationId}
        `.pipe(
          Effect.mapError(storageError),
          Effect.andThen(PubSub.publish(changes, threadId)),
          Effect.asVoid,
        ),
    });
  });

  const insertExcerpt = Effect.fn("MessageBookmarks.insertExcerpt")(function* (input: {
    readonly threadId: ThreadId;
    readonly bookmarkId: string;
    readonly runId: string | null;
    readonly target: SavedTarget;
    readonly title: string;
    readonly generationId: string | null;
  }) {
    const targetJson = yield* encodeExcerptTarget(input.target).pipe(Effect.mapError(storageError));
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* sql`
      INSERT INTO message_bookmark_excerpts
        (thread_id, bookmark_id, run_id, target_json, title, created_at, generation_id)
      VALUES (${input.threadId}, ${input.bookmarkId}, ${input.runId}, ${targetJson},
        ${input.title}, ${createdAt}, ${input.generationId})
      ON CONFLICT (thread_id, bookmark_id) DO NOTHING RETURNING bookmark_id
    `.pipe(Effect.mapError(storageError));
    if (inserted.length > 0) yield* PubSub.publish(changes, input.threadId);
    return inserted.length > 0;
  });

  const add: MessageBookmarks["Service"]["add"] = Effect.fn("MessageBookmarks.add")(
    function* (input) {
      const { threadId, target } = input;
      if (target.type === "message") return yield* addWholeMessage(threadId, target.messageId);
      if (target.type === "text") {
        const { thread, message } = yield* findMessage(threadId, target.messageId);
        const completion = yield* turnCompletion(threadId);
        yield* ensureTurnCompleted(completion.messages.get(target.messageId));
        const bookmarkId = `text:${target.messageId}:${target.selection.start}-${target.selection.end}`;
        const title = messageBookmarkTitle(target.selection.text);
        const generationId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError));
        const inserted = yield* insertExcerpt({
          threadId,
          bookmarkId,
          runId: message.runId,
          target,
          title,
          generationId,
        });
        if (!inserted) return;
        return yield* generateTitleLater({
          projectId: thread.projectId,
          worktreePath: thread.worktreePath,
          text: target.selection.text,
          fallbackTitle: title,
          save: (generated) =>
            sql`
              UPDATE message_bookmark_excerpts SET title = ${generated}, generation_id = NULL
              WHERE thread_id = ${threadId} AND bookmark_id = ${bookmarkId}
                AND generation_id = ${generationId}
            `.pipe(
              Effect.mapError(storageError),
              Effect.andThen(PubSub.publish(changes, threadId)),
              Effect.asVoid,
            ),
        });
      }
      yield* ensureThreadAvailable(threadId);
      const completion = yield* turnCompletion(threadId);
      const visibleItem = completion.items.get(target.itemId);
      yield* ensureTurnCompleted(visibleItem?.completed);
      if (!visibleItem) return;
      const item = yield* projections
        .getTurnItem({ threadId: visibleItem.sourceThreadId, itemId: target.itemId })
        .pipe(Effect.mapError(storageError));
      const htmlRender =
        item?.type === "dynamic_tool" && item.status === "completed"
          ? htmlRenderFromToolItem(item)
          : undefined;
      if (!item || !htmlRender)
        return yield* new MessageBookmarkError({ reason: "message-not-found" });
      // A page already has a title, so no model call is needed.
      yield* insertExcerpt({
        threadId,
        bookmarkId: `page:${target.itemId}`,
        runId: item.runId,
        target: { type: "page", itemId: target.itemId, htmlRender },
        title: htmlRender.title.trim().slice(0, 160).trim() || "Page",
        generationId: null,
      });
    },
  );

  const rename: MessageBookmarks["Service"]["rename"] = Effect.fn("MessageBookmarks.rename")(
    function* (input) {
      yield* ensureThreadAvailable(input.threadId);
      const updatedExcerpt = yield* sql`
        UPDATE message_bookmark_excerpts SET title = ${input.title}, generation_id = NULL
        WHERE thread_id = ${input.threadId} AND bookmark_id = ${input.bookmarkId}
        RETURNING bookmark_id
      `.pipe(Effect.mapError(storageError));
      const updated =
        updatedExcerpt.length > 0
          ? updatedExcerpt
          : yield* sql`
              UPDATE message_bookmarks SET title = ${input.title}, generation_id = NULL
              WHERE thread_id = ${input.threadId} AND message_id = ${input.bookmarkId}
              RETURNING message_id
            `.pipe(Effect.mapError(storageError));
      if (updated.length === 0)
        return yield* new MessageBookmarkError({ reason: "bookmark-not-found" });
      yield* PubSub.publish(changes, input.threadId);
    },
  );

  const remove: MessageBookmarks["Service"]["remove"] = Effect.fn("MessageBookmarks.remove")(
    function* (input) {
      yield* ensureThreadAvailable(input.threadId);
      const deletedExcerpt = yield* sql`
        DELETE FROM message_bookmark_excerpts
        WHERE thread_id = ${input.threadId} AND bookmark_id = ${input.bookmarkId}
        RETURNING bookmark_id
      `.pipe(Effect.mapError(storageError));
      const deleted =
        deletedExcerpt.length > 0
          ? deletedExcerpt
          : yield* sql`
              DELETE FROM message_bookmarks
              WHERE thread_id = ${input.threadId} AND message_id = ${input.bookmarkId}
              RETURNING message_id
            `.pipe(Effect.mapError(storageError));
      if (deleted.length === 0)
        return yield* new MessageBookmarkError({ reason: "bookmark-not-found" });
      yield* PubSub.publish(changes, input.threadId);
    },
  );

  const subscribe: MessageBookmarks["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(listSaved(input)),
          Stream.fromSubscription(queue).pipe(
            Stream.filter((threadId) => threadId === input.threadId),
            Stream.mapEffect(() => listSaved(input)),
          ),
        );
      }),
    );
  return MessageBookmarks.of({
    list,
    listSaved,
    listWithExchanges,
    subscribe,
    add,
    rename,
    remove,
  });
});
export const layer = Layer.effect(MessageBookmarks, make);
