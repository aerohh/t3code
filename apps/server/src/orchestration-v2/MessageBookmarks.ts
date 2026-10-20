import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import {
  MessageBookmark,
  MessageBookmarkError,
  type MessageBookmarkTarget,
  type MessageBookmarkRenameInput,
  type MessageBookmarksInput,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import { messageBookmarkTitle } from "@t3tools/shared/messageBookmarkTitle";
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
    readonly list: (
      input: MessageBookmarksInput,
    ) => Effect.Effect<readonly MessageBookmark[], MessageBookmarkError>;
    readonly subscribe: (
      input: MessageBookmarksInput,
    ) => Stream.Stream<readonly MessageBookmark[], MessageBookmarkError>;
    readonly add: (input: MessageBookmarkTarget) => Effect.Effect<void, MessageBookmarkError>;
    readonly rename: (
      input: MessageBookmarkRenameInput,
    ) => Effect.Effect<void, MessageBookmarkError>;
    readonly remove: (input: MessageBookmarkTarget) => Effect.Effect<void, MessageBookmarkError>;
  }
>()("t3/orchestration-v2/MessageBookmarks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Not a numbered migration: this fork shares databases with official builds,
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
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<string>();
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const generation = yield* TextGeneration.TextGeneration;
  const storageError = (cause: unknown) => new MessageBookmarkError({ reason: "storage", cause });
  const decode = Schema.decodeUnknownEffect(Schema.Array(MessageBookmark));
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
  const list: MessageBookmarks["Service"]["list"] = Effect.fn("MessageBookmarks.list")(
    function* (input) {
      yield* ensureThreadAvailable(input.threadId);
      const rows = yield* sql`
      SELECT thread_id AS "threadId", message_id AS "messageId", run_id AS "runId",
        title, created_at AS "createdAt"
      FROM message_bookmarks WHERE thread_id = ${input.threadId}
      ORDER BY created_at, message_id
    `.pipe(Effect.mapError(storageError));
      const bookmarks = yield* decode(rows).pipe(Effect.mapError(storageError));
      // Undoing a turn hides its messages but keeps their bookmark rows.
      const visible = yield* projections
        .getVisibleMessageIds(input.threadId)
        .pipe(Effect.mapError(storageError));
      return bookmarks.filter((bookmark) => visible.has(bookmark.messageId));
    },
  );
  const add: MessageBookmarks["Service"]["add"] = Effect.fn("MessageBookmarks.add")(
    function* (input) {
      const projection = yield* projections
        .getThreadRecords(input.threadId, ["messages"], {
          messageIds: [input.messageId],
        })
        .pipe(Effect.mapError(storageError));
      if (projection.thread.deletedAt !== null)
        return yield* new MessageBookmarkError({ reason: "message-not-found" });
      let message:
        | Pick<OrchestrationV2ConversationMessage, "role" | "text" | "attachments" | "runId">
        | undefined = projection.messages.find((message) => message.id === input.messageId);
      if (!message) {
        // A fork keeps inherited messages in their source thread. Read through the
        // visible index so a message beyond the fork boundary cannot be bookmarked.
        const page = yield* projections
          .getTimelinePage(input.threadId, { messageId: input.messageId, limit: 1 })
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
      const visible = yield* projections
        .getVisibleMessageIds(input.threadId)
        .pipe(Effect.mapError(storageError));
      if (!visible.has(input.messageId))
        return yield* new MessageBookmarkError({ reason: "message-not-found" });
      const title = messageBookmarkTitle(message.text, message.attachments[0]?.name);
      const generationId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError));
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* sql`
      INSERT INTO message_bookmarks (thread_id, message_id, run_id, title, created_at, generation_id)
      VALUES (${input.threadId}, ${input.messageId}, ${message.runId}, ${title}, ${createdAt}, ${generationId})
      ON CONFLICT (thread_id, message_id) DO NOTHING RETURNING message_id
    `.pipe(Effect.mapError(storageError));
      if (inserted.length === 0) return;
      // Persist first. Losing the connection or a model failure must never lose the bookmark.
      yield* PubSub.publish(changes, input.threadId);
      const savedMessage = message;
      yield* Effect.gen(function* () {
        const generated = yield* Effect.gen(function* () {
          const project = yield* projects.get(projection.thread.projectId);
          if (Option.isNone(project)) return null;
          const resolved = resolveProjectSettings(
            yield* settings.getSettings,
            projection.thread.projectId,
          ).settings;
          const result = yield* generation.generateThreadTitle({
            cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
            message: savedMessage.text.trim() ? savedMessage.text.slice(0, 12_000) : title,
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
        // A rename, removal, or re-add while generation runs wins over the late model response.
        yield* sql`
      UPDATE message_bookmarks SET title = ${generated}, generation_id = NULL
      WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
        AND generation_id = ${generationId}
    `.pipe(Effect.asVoid, Effect.mapError(storageError));
        yield* PubSub.publish(changes, input.threadId);
      }).pipe(Effect.ignore, Effect.forkIn(serviceScope));
    },
  );
  const rename: MessageBookmarks["Service"]["rename"] = Effect.fn("MessageBookmarks.rename")(
    function* (input) {
      yield* ensureThreadAvailable(input.threadId);
      const updated = yield* sql`
      UPDATE message_bookmarks SET title = ${input.title}, generation_id = NULL
      WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
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
      const deleted = yield* sql`
      DELETE FROM message_bookmarks
      WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
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
          Stream.fromEffect(list(input)),
          Stream.fromSubscription(queue).pipe(
            Stream.filter((threadId) => threadId === input.threadId),
            Stream.mapEffect(() => list(input)),
          ),
        );
      }),
    );
  return MessageBookmarks.of({ list, subscribe, add, rename, remove });
});
export const layer = Layer.effect(MessageBookmarks, make);
