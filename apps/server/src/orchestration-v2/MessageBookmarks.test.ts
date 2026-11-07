import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  RunId,
  TurnItemId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
  type MessageBookmarkWithExchange,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SideChat,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as MessageBookmarks from "./MessageBookmarks.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ServerSettings from "../serverSettings.ts";

const layerStorage = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerTest = MessageBookmarks.layer.pipe(
  Layer.provideMerge(layerStorage),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(NodeCrypto.layer),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: {
    readonly archivedAt?: DateTime.Utc;
    readonly deletedAt?: DateTime.Utc;
    readonly sideChat?: OrchestrationV2SideChat;
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    ...(overrides.sideChat === undefined ? {} : { sideChat: overrides.sideChat }),
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

let nextOrdinal = 0;
// The chat shows timeline items, so user and assistant messages also get one, as in production.
const addMessage = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: {
    readonly minute?: number;
    readonly runId?: RunId;
    readonly inputIntent?: "turn_start" | "steer";
  } = {},
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const occurredAt = at(options.minute ?? 1);
    const runId = options.runId ?? null;
    yield* projections.apply({
      id: EventId.make(`message:${id}`),
      type: "message.updated",
      threadId,
      providerInstanceId,
      occurredAt,
      payload: {
        createdBy: role === "user" ? "user" : "agent",
        creationSource: role === "user" ? "web" : "provider",
        id: MessageId.make(id),
        threadId,
        runId,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    });
    if (role === "system") return;
    const base = {
      id: TurnItemId.make(`item:${id}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ++nextOrdinal,
      status: "completed" as const,
      title: null,
      startedAt: occurredAt,
      completedAt: occurredAt,
      updatedAt: occurredAt,
      messageId: MessageId.make(id),
      text,
    };
    yield* projections.apply({
      id: EventId.make(`item:${id}`),
      threadId,
      occurredAt,
      type: "turn-item.updated",
      payload:
        role === "user"
          ? {
              ...base,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: options.inputIntent ?? "turn_start",
              attachments: [],
            }
          : { ...base, type: "assistant_message", streaming: false },
    });
  });

const setup = Effect.gen(function* () {
  const projectId = ProjectId.make("bookmarks-project");
  const threadId = ThreadId.make("bookmarks-thread");
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* createProject(projectId);
  yield* projections.apply(thread(threadId, projectId));
  const target = { threadId, messageId: MessageId.make("bookmark-message") };
  yield* addMessage(
    threadId,
    target.messageId,
    "assistant",
    "**How** to keep useful messages close at hand forever",
  );
  return { target, projections, service: yield* MessageBookmarks.MessageBookmarks };
});

const addToolCall = (threadId: ThreadId, id: string, toolName: string, runId: RunId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const occurredAt = at(1);
    yield* projections.apply({
      id: EventId.make(`item:${id}`),
      threadId,
      occurredAt,
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`item:${id}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: ++nextOrdinal,
        status: "completed",
        title: null,
        startedAt: occurredAt,
        completedAt: occurredAt,
        updatedAt: occurredAt,
        type: "dynamic_tool",
        toolName,
        input: {},
        output: [
          {
            type: "text",
            text: JSON.stringify({ htmlRender: { attachmentId: id, title: id, height: 300 } }),
          },
        ],
      },
    });
  });

const describeEntries = (entry: MessageBookmarkWithExchange | undefined) =>
  entry?.entries.map((item) =>
    item.type === "page" ? `page: ${item.htmlRender.title}` : `${item.role}: ${item.text}`,
  );

const wholeMessage = (input: { readonly threadId: ThreadId; readonly messageId: MessageId }) => ({
  threadId: input.threadId,
  target: { type: "message" as const, messageId: input.messageId },
});
const byMessage = (input: { readonly threadId: ThreadId; readonly messageId: MessageId }) => ({
  threadId: input.threadId,
  bookmarkId: input.messageId,
});

const offline = Layer.mock(TextGeneration.TextGeneration)({
  generateThreadTitle: () =>
    Effect.fail(new TextGenerationError({ operation: "generateThreadTitle", detail: "offline" })),
});

it.effect("persists, isolates, renames, removes, and does not cap bookmarks at 100", () =>
  Effect.gen(function* () {
    const { service, target, projections } = yield* setup;
    for (let index = 0; index < 105; index++) {
      const messageId = MessageId.make(`bookmark-${index}`);
      yield* addMessage(
        target.threadId,
        messageId,
        index % 2 ? "user" : "assistant",
        `Message ${index}`,
      );
      yield* service.add(wholeMessage({ threadId: target.threadId, messageId }));
    }
    yield* service.add(wholeMessage(target));
    yield* service.add(wholeMessage(target));
    const rows = yield* service.list(target);
    assert.strictEqual(rows.length, 106);
    const withExchanges = yield* service.listWithExchanges(target);
    assert.strictEqual(withExchanges.length, 106);
    const exchangeOf = (messageId: string) =>
      describeEntries(withExchanges.find((entry) => entry.bookmarkId === messageId));
    // Bookmarking the prompt or the reply shows the same prompt-and-reply exchange.
    assert.deepStrictEqual(exchangeOf("bookmark-1"), ["user: Message 1", "assistant: Message 2"]);
    assert.deepStrictEqual(exchangeOf("bookmark-2"), ["user: Message 1", "assistant: Message 2"]);
    assert.deepStrictEqual(exchangeOf(target.messageId), [
      "assistant: **How** to keep useful messages close at hand forever",
      "assistant: Message 0",
    ]);
    const work = RunId.make("busy-run");
    const followUp = RunId.make("follow-up-run");
    const busyTurn = [
      ["busy-prompt", "user", "Fix it", work],
      ["busy-progress", "assistant", "Checking files", work],
      ["busy-steer", "user", "Also the docs", work],
      ["busy-docs", "assistant", "Now the docs", work],
      ["busy-final", "assistant", "Done", work],
      ["follow-up-progress", "assistant", "Checking again", followUp],
      ["follow-up-final", "assistant", "Still done", followUp],
    ] as const;
    for (const [id, role, text, runId] of busyTurn) {
      yield* addMessage(target.threadId, id, role, text, {
        runId,
        inputIntent: id === "busy-steer" ? "steer" : "turn_start",
      });
      if (id === "busy-docs") {
        yield* addToolCall(target.threadId, "Docs page", "mcp__t3-code__html_render", work);
        yield* addToolCall(target.threadId, "Not a page", "mcp__t3-code__html_preview", work);
      }
    }
    yield* service.add(
      wholeMessage({ threadId: target.threadId, messageId: MessageId.make("busy-prompt") }),
    );
    yield* service.add(
      wholeMessage({ threadId: target.threadId, messageId: MessageId.make("busy-progress") }),
    );
    const busyExchanges = yield* service.listWithExchanges(target);
    const busyExchangeOf = (messageId: string) =>
      describeEntries(busyExchanges.find((entry) => entry.bookmarkId === messageId));
    // As in the chat after a turn ends: a steer and inline pages stay, other tool calls and
    // progress messages fold into each run's last reply.
    assert.deepStrictEqual(busyExchangeOf("busy-prompt"), [
      "user: Fix it",
      "user: Also the docs",
      "page: Docs page",
      "assistant: Done",
      "assistant: Still done",
    ]);
    // A bookmarked progress message still shows.
    assert.deepStrictEqual(busyExchangeOf("busy-progress"), [
      "user: Fix it",
      "assistant: Checking files",
      "user: Also the docs",
      "page: Docs page",
      "assistant: Done",
      "assistant: Still done",
    ]);

    const selection = { text: "Done", start: 0, end: 4, prefix: "", suffix: "" };
    const textTarget = {
      type: "text" as const,
      messageId: MessageId.make("busy-final"),
      selection,
    };
    const pageItemId = TurnItemId.make("item:Docs page");
    yield* service.add({ threadId: target.threadId, target: textTarget });
    yield* service.add({ threadId: target.threadId, target: textTarget });
    yield* service.add({ threadId: target.threadId, target: { type: "page", itemId: pageItemId } });
    const notAPage = TurnItemId.make("item:Not a page");
    assert.strictEqual(
      (yield* service
        .add({ threadId: target.threadId, target: { type: "page", itemId: notAPage } })
        .pipe(Effect.flip)).reason,
      "message-not-found",
    );
    const saved = yield* service.listSaved(target);
    const textId = "text:busy-final:0-4";
    const pageId = `page:${pageItemId}`;
    assert.deepStrictEqual(
      saved.filter((bookmark) => bookmark.target.type !== "message"),
      saved.filter((bookmark) => bookmark.id === textId || bookmark.id === pageId),
    );
    assert.deepStrictEqual(saved.find((bookmark) => bookmark.id === textId)?.target, textTarget);
    const page = saved.find((bookmark) => bookmark.id === pageId);
    assert.strictEqual(page?.title, "Docs page");
    assert.deepStrictEqual(page?.target, {
      type: "page",
      itemId: pageItemId,
      htmlRender: { attachmentId: "Docs page", title: "Docs page", height: 300 },
    });
    // Agent tools keep seeing whole-message bookmarks only.
    assert.isFalse((yield* service.list(target)).some((row) => row.messageId === "busy-final"));
    yield* service.rename({ threadId: target.threadId, bookmarkId: pageId, title: "Renamed page" });
    assert.strictEqual(
      (yield* service.listSaved(target)).find((bookmark) => bookmark.id === pageId)?.title,
      "Renamed page",
    );
    yield* service.remove({ threadId: target.threadId, bookmarkId: textId });
    yield* service.remove({ threadId: target.threadId, bookmarkId: pageId });
    assert.isFalse(
      (yield* service.listSaved(target)).some((bookmark) => bookmark.target.type !== "message"),
    );
    assert.strictEqual(
      rows.find((row) => row.messageId === target.messageId)?.title,
      "How to keep useful messages close at hand",
    );
    yield* service.rename({ ...byMessage(target), title: "My title" });
    assert.strictEqual(
      (yield* service.list(target)).find((row) => row.messageId === target.messageId)?.title,
      "My title",
    );
    const other = ThreadId.make("other-bookmark-thread");
    yield* projections.apply(thread(other, ProjectId.make("bookmarks-project")));
    assert.deepStrictEqual(yield* service.list({ threadId: other }), []);
    yield* service.remove(byMessage(target));
    assert.strictEqual((yield* service.list(target)).length, 107);
    assert.strictEqual(
      (yield* service.remove(byMessage(target)).pipe(Effect.flip)).reason,
      "bookmark-not-found",
    );
    assert.strictEqual(
      (yield* service.rename({ ...byMessage(target), title: "Gone" }).pipe(Effect.flip)).reason,
      "bookmark-not-found",
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(offline)))),
);

it.effect("rejects missing messages and system messages", () =>
  Effect.gen(function* () {
    const { service, target } = yield* setup;
    const missing = yield* service
      .add(wholeMessage({ ...target, messageId: MessageId.make("absent") }))
      .pipe(Effect.flip);
    assert.strictEqual(missing.reason, "message-not-found");
    const system = MessageId.make("system");
    yield* addMessage(target.threadId, system, "system", "Internal message");
    assert.strictEqual(
      (yield* service.add(wholeMessage({ ...target, messageId: system })).pipe(Effect.flip)).reason,
      "message-not-found",
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(offline)))),
);

it.effect("hides and refuses bookmarks on undone, running, and cut-short turns", () =>
  Effect.gen(function* () {
    const { service, target, projections } = yield* setup;
    const runId = RunId.make("undone-run");
    const run = {
      id: runId,
      threadId: target.threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-6" },
      providerThreadId: null,
      userMessageId: MessageId.make("undone-prompt"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed" as const,
      requestedAt: at(1),
      startedAt: at(1),
      completedAt: at(2),
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* projections.apply({
      id: EventId.make("run:undone"),
      threadId: target.threadId,
      occurredAt: at(1),
      type: "run.created",
      payload: run,
    });
    const undone = MessageId.make("undone-answer");
    const later = MessageId.make("undone-later");
    yield* addMessage(target.threadId, undone, "assistant", "Answer that gets undone", { runId });
    yield* addMessage(target.threadId, later, "assistant", "Also undone", { runId });
    yield* service.add(wholeMessage(target));
    yield* service.add(wholeMessage({ ...target, messageId: undone }));
    assert.strictEqual((yield* service.list(target)).length, 2);
    yield* projections.apply({
      id: EventId.make("run:undone:rolled-back"),
      threadId: target.threadId,
      occurredAt: at(3),
      type: "run.updated",
      payload: { ...run, status: "rolled_back" },
    });
    assert.deepStrictEqual(
      (yield* service.list(target)).map((bookmark) => bookmark.messageId),
      [target.messageId],
    );
    assert.deepStrictEqual(
      (yield* service.listWithExchanges(target)).map((entry) =>
        entry.entries.map((item) => (item.type === "message" ? item.messageId : item.itemId)),
      ),
      [[target.messageId]],
    );
    assert.strictEqual(
      (yield* service.add(wholeMessage({ ...target, messageId: later })).pipe(Effect.flip)).reason,
      "message-not-found",
    );

    const runningRunId = RunId.make("running-run");
    yield* projections.apply({
      id: EventId.make("run:running"),
      threadId: target.threadId,
      occurredAt: at(4),
      type: "run.created",
      payload: { ...run, id: runningRunId, ordinal: 2, status: "running", completedAt: null },
    });
    const progress = MessageId.make("running-progress");
    yield* addMessage(target.threadId, progress, "assistant", "Still working", {
      runId: runningRunId,
    });
    assert.strictEqual(
      (yield* service.add(wholeMessage({ ...target, messageId: progress })).pipe(Effect.flip))
        .reason,
      "turn-not-completed",
    );
    assert.strictEqual(
      (yield* service
        .add({
          threadId: target.threadId,
          target: {
            type: "text",
            messageId: progress,
            selection: { text: "Still", start: 0, end: 5, prefix: "", suffix: "" },
          },
        })
        .pipe(Effect.flip)).reason,
      "turn-not-completed",
    );
    // A turn that hasn't completed stays out of the card it would continue.
    assert.deepStrictEqual(
      (yield* service.listWithExchanges(target)).map((entry) =>
        entry.entries.map((item) => (item.type === "message" ? item.messageId : item.itemId)),
      ),
      [[target.messageId]],
    );

    const stoppedRunId = RunId.make("stopped-run");
    const stoppedRun = { ...run, id: stoppedRunId, ordinal: 3 };
    yield* projections.apply({
      id: EventId.make("run:stopped"),
      threadId: target.threadId,
      occurredAt: at(5),
      type: "run.created",
      payload: stoppedRun,
    });
    const stoppedPrompt = MessageId.make("stopped-prompt");
    yield* addMessage(target.threadId, stoppedPrompt, "user", "Stop me", { runId: stoppedRunId });
    // Saved before the rule existed, then the turn turned out to be cut short.
    yield* service.add(wholeMessage({ ...target, messageId: stoppedPrompt }));
    yield* projections.apply({
      id: EventId.make("run:stopped:interrupted"),
      threadId: target.threadId,
      occurredAt: at(6),
      type: "run.updated",
      payload: { ...stoppedRun, status: "interrupted" },
    });
    assert.deepStrictEqual(
      (yield* service.list(target)).map((bookmark) => bookmark.messageId),
      [target.messageId],
    );
    yield* service.remove(byMessage({ ...target, messageId: stoppedPrompt }));
    assert.strictEqual(
      (yield* service.add(wholeMessage({ ...target, messageId: stoppedPrompt })).pipe(Effect.flip))
        .reason,
      "turn-not-completed",
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(offline)))),
);

it.effect("publishes generated titles after immediately saving a fallback", () =>
  Effect.gen(function* () {
    const response = yield* Deferred.make<{ title: string }>();
    const started = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { service, target } = yield* setup;
      yield* service.add(wholeMessage(target));
      yield* Deferred.await(started);
      assert.strictEqual(
        (yield* service.list(target))[0]?.title,
        "How to keep useful messages close at hand",
      );
      yield* Deferred.succeed(response, { title: "Useful messages" });
      const generated = yield* service.subscribe(target).pipe(
        Stream.filter((rows) => rows[0]?.title === "Useful messages"),
        Stream.runHead,
      );
      assert.isTrue(generated._tag === "Some");
    }).pipe(
      Effect.provide(
        layerTest.pipe(
          Layer.provide(
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: () =>
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(response))),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("a model that never responds times out and keeps the fallback", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { service, target } = yield* setup;
      yield* service.add(wholeMessage(target));
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(interrupted);
      assert.strictEqual(
        (yield* service.list(target))[0]?.title,
        "How to keep useful messages close at hand",
      );
    }).pipe(
      Effect.provide(
        layerTest.pipe(
          Layer.provide(
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                ),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("late generation cannot overwrite a rename or resurrect a removed bookmark", () =>
  Effect.gen(function* () {
    const response = yield* Deferred.make<{ title: string }>();
    yield* Effect.gen(function* () {
      const { service, target } = yield* setup;
      yield* service.add(wholeMessage(target));
      yield* service.rename({ ...byMessage(target), title: "Chosen title" });
      const initial = yield* Deferred.make<void>();
      const updated =
        yield* Deferred.make<readonly import("@t3tools/contracts").SavedMessageBookmark[]>();
      let first = true;
      const subscriber = yield* service.subscribe(target).pipe(
        Stream.runForEach((rows) => {
          if (first) {
            first = false;
            return Deferred.succeed(initial, undefined);
          }
          return Deferred.succeed(updated, rows);
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(initial);
      yield* Deferred.succeed(response, { title: "Late generated title" });
      assert.strictEqual((yield* Deferred.await(updated))[0]?.title, "Chosen title");
      yield* Fiber.interrupt(subscriber);
      yield* service.remove(byMessage(target));
      assert.deepStrictEqual(yield* service.list(target), []);
    }).pipe(
      Effect.provide(
        layerTest.pipe(
          Layer.provide(
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: () => Deferred.await(response),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("late generation cannot change a newly re-added bookmark", () =>
  Effect.gen(function* () {
    const response = yield* Deferred.make<{ title: string }>();
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    let calls = 0;
    yield* Effect.gen(function* () {
      const { service, target } = yield* setup;
      yield* service.add(wholeMessage(target));
      yield* Deferred.await(firstStarted);
      yield* service.remove(byMessage(target));
      yield* service.add(wholeMessage(target));
      yield* Deferred.await(secondStarted);
      const initial = yield* Deferred.make<void>();
      const completed =
        yield* Deferred.make<readonly import("@t3tools/contracts").SavedMessageBookmark[]>();
      let first = true;
      const subscriber = yield* service.subscribe(target).pipe(
        Stream.runForEach((rows) => {
          if (first) {
            first = false;
            return Deferred.succeed(initial, undefined);
          }
          return Deferred.succeed(completed, rows);
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(initial);
      yield* Deferred.succeed(response, { title: "Outdated title" });
      assert.strictEqual(
        (yield* Deferred.await(completed))[0]?.title,
        "How to keep useful messages close at hand",
      );
      yield* Fiber.interrupt(subscriber);
    }).pipe(
      Effect.provide(
        layerTest.pipe(
          Layer.provide(
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: () =>
                ++calls === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(response)),
                    )
                  : Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("bookmarks inherited messages only through the fork boundary", () =>
  Effect.gen(function* () {
    const { service, target, projections } = yield* setup;
    const source = target.threadId;
    const sourceRun = RunId.make("source-run");
    const laterRun = RunId.make("later-run");
    for (const [index, runId] of [sourceRun, laterRun].entries()) {
      yield* projections.apply({
        id: EventId.make(`run:${runId}`),
        threadId: source,
        occurredAt: at(1),
        type: "run.created",
        payload: {
          id: runId,
          threadId: source,
          ordinal: index + 1,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-6" },
          providerThreadId: null,
          userMessageId: MessageId.make(`prompt-${runId}`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: at(1),
          startedAt: at(1),
          completedAt: at(2),
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`item:${runId}`),
        threadId: source,
        occurredAt: at(1),
        type: "turn-item.updated",
        payload: {
          id: TurnItemId.make(`item-${runId}`),
          threadId: source,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index + 1,
          status: "completed",
          title: null,
          startedAt: at(1),
          completedAt: at(2),
          updatedAt: at(2),
          type: "assistant_message",
          messageId: MessageId.make(`message-${runId}`),
          text: `Inherited message ${index}`,
          streaming: false,
        },
      });
    }
    const forkId = ThreadId.make("fork-bookmarks");
    const fork = thread(forkId, ProjectId.make("bookmarks-project"));
    if (fork.type !== "thread.created") return;
    yield* projections.apply({
      ...fork,
      payload: { ...fork.payload, forkedFrom: { type: "run", threadId: source, runId: sourceRun } },
    });
    yield* service.add(
      wholeMessage({ threadId: forkId, messageId: MessageId.make(`message-${sourceRun}`) }),
    );
    assert.strictEqual(
      (yield* service.list({ threadId: forkId }))[0]?.title,
      "Inherited message 0",
    );
    const [inherited] = yield* service.listWithExchanges({ threadId: forkId });
    assert.deepStrictEqual(describeEntries(inherited), ["assistant: Inherited message 0"]);
    assert.deepStrictEqual(yield* service.list(target), []);
    assert.strictEqual(
      (yield* service
        .add(wholeMessage({ threadId: forkId, messageId: MessageId.make(`message-${laterRun}`) }))
        .pipe(Effect.flip)).reason,
      "message-not-found",
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(offline)))),
);
