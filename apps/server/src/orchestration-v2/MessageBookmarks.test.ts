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
  type OrchestrationV2DomainEvent,
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
    readonly sideChat?: { readonly canReadFiles: boolean };
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
  options: { readonly minute?: number; readonly runId?: RunId } = {},
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
              inputIntent: "turn_start",
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
      yield* service.add({ threadId: target.threadId, messageId });
    }
    yield* service.add(target);
    yield* service.add(target);
    const rows = yield* service.list(target);
    assert.strictEqual(rows.length, 106);
    assert.strictEqual(
      rows.find((row) => row.messageId === target.messageId)?.title,
      "How to keep useful messages close at hand",
    );
    yield* service.rename({ ...target, title: "My title" });
    assert.strictEqual(
      (yield* service.list(target)).find((row) => row.messageId === target.messageId)?.title,
      "My title",
    );
    const other = ThreadId.make("other-bookmark-thread");
    yield* projections.apply(thread(other, ProjectId.make("bookmarks-project")));
    assert.deepStrictEqual(yield* service.list({ threadId: other }), []);
    yield* service.remove(target);
    assert.strictEqual((yield* service.list(target)).length, 105);
    assert.strictEqual(
      (yield* service.remove(target).pipe(Effect.flip)).reason,
      "bookmark-not-found",
    );
    assert.strictEqual(
      (yield* service.rename({ ...target, title: "Gone" }).pipe(Effect.flip)).reason,
      "bookmark-not-found",
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(offline)))),
);

it.effect("rejects missing messages and system messages", () =>
  Effect.gen(function* () {
    const { service, target, projections } = yield* setup;
    const missing = yield* service
      .add({ ...target, messageId: MessageId.make("absent") })
      .pipe(Effect.flip);
    assert.strictEqual(missing.reason, "message-not-found");
    const system = MessageId.make("system");
    yield* addMessage(target.threadId, system, "system", "Internal message");
    assert.strictEqual(
      (yield* service.add({ ...target, messageId: system }).pipe(Effect.flip)).reason,
      "message-not-found",
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(offline)))),
);

it.effect("hides bookmarks whose message was undone and refuses to add them", () =>
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
    yield* service.add(target);
    yield* service.add({ ...target, messageId: undone });
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
    assert.strictEqual(
      (yield* service.add({ ...target, messageId: later }).pipe(Effect.flip)).reason,
      "message-not-found",
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(offline)))),
);

it.effect("publishes generated titles after immediately saving a fallback", () =>
  Effect.gen(function* () {
    const response = yield* Deferred.make<{ title: string }>();
    const started = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { service, target } = yield* setup;
      yield* service.add(target);
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
      yield* service.add(target);
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
      yield* service.add(target);
      yield* service.rename({ ...target, title: "Chosen title" });
      const initial = yield* Deferred.make<void>();
      const updated =
        yield* Deferred.make<readonly import("@t3tools/contracts").MessageBookmark[]>();
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
      yield* service.remove(target);
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
      yield* service.add(target);
      yield* Deferred.await(firstStarted);
      yield* service.remove(target);
      yield* service.add(target);
      yield* Deferred.await(secondStarted);
      const initial = yield* Deferred.make<void>();
      const completed =
        yield* Deferred.make<readonly import("@t3tools/contracts").MessageBookmark[]>();
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
    yield* service.add({ threadId: forkId, messageId: MessageId.make(`message-${sourceRun}`) });
    assert.strictEqual(
      (yield* service.list({ threadId: forkId }))[0]?.title,
      "Inherited message 0",
    );
    assert.deepStrictEqual(yield* service.list(target), []);
    assert.strictEqual(
      (yield* service
        .add({ threadId: forkId, messageId: MessageId.make(`message-${laterRun}`) })
        .pipe(Effect.flip)).reason,
      "message-not-found",
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(offline)))),
);
