import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (["codex", "claudeAgent"] as const).flatMap((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  return (["failed", "interrupted", "cancelled"] as const).map((status) => ({
    driver,
    status,
    instanceId,
    modelSelection,
    layer,
  }));
});

it.effect.each(forkCases)(
  "bounds $driver context when continuing a fork of a $status run",
  ({ driver, status, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      // A cancelled queue entry has no provider turn; an early interruption
      // can have a turn but no native assistant cursor.
      if (status === "interrupted") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      for (const ordinal of [1, 2]) {
        const runId = ordinal === 1 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: ordinal === 1 && status === "interrupted" ? attemptId : null,
                status: ordinal === 1 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 1 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);

const sideChatParentThreadId = ThreadId.make("side-chat-parent");
const sideChatThreadId = ThreadId.make("side-chat");

const sideChatLayerFor = (driverName: "claudeAgent" | "codex") => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Side chat tests never start a turn"),
  };
  return {
    instanceId,
    layer: ProviderReplayHarness.layerWithRegistry(
      { name: `side-chat-open-${driver}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { runEffectWorker: false },
    ),
  };
};

const createSideChatParent = (
  instanceId: ProviderInstanceId,
  runStatuses: ReadonlyArray<OrchestrationV2Run["status"]>,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const modelSelection = { instanceId, model: "test-model" };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-side-chat-parent"),
      threadId: sideChatParentThreadId,
      projectId: ProjectId.make("side-chat-project"),
      title: "Side chat parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    for (const [index, status] of runStatuses.entries()) {
      const ordinal = index + 1;
      const runId = RunId.make(`side-chat-parent-run-${ordinal}`);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`side-chat-parent-run-${ordinal}`),
            type: "run.created",
            threadId: sideChatParentThreadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: sideChatParentThreadId,
              ordinal,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`side-chat-parent-message-${ordinal}`),
              rootNodeId: null,
              activeAttemptId: null,
              status,
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: status === "running" ? null : now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
    }
    return orchestrator;
  });

const openSideChat = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  targetThreadId = sideChatThreadId,
) =>
  orchestrator.dispatch({
    type: "thread.side-chat.open",
    commandId: CommandId.make(`open-${targetThreadId}`),
    parentThreadId: sideChatParentThreadId,
    sideChatThreadId: targetThreadId,
    createdBy: "user",
    creationSource: "web",
  });

it.effect("opens a side chat from the latest finished run while the parent still works", () => {
  const { instanceId, layer } = sideChatLayerFor("claudeAgent");
  return Effect.gen(function* () {
    const orchestrator = yield* createSideChatParent(instanceId, [
      "completed",
      "completed",
      "running",
    ]);
    yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("pin-side-chat-parent"),
      threadId: sideChatParentThreadId,
    });
    yield* openSideChat(orchestrator);

    const sideChat = (yield* orchestrator.getThreadProjection(sideChatThreadId)).thread;
    assert.deepEqual(sideChat.sideChat, { canReadFiles: false });
    assert.equal(sideChat.interactionMode, "default");
    assert.isNull(sideChat.pinnedAt);
    assert.equal(sideChat.lineage.parentThreadId, sideChatParentThreadId);
    assert.deepEqual(sideChat.forkedFrom, {
      type: "run",
      threadId: sideChatParentThreadId,
      runId: RunId.make("side-chat-parent-run-2"),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("keeps one side chat per parent", () => {
  const { instanceId, layer } = sideChatLayerFor("claudeAgent");
  return Effect.gen(function* () {
    const orchestrator = yield* createSideChatParent(instanceId, ["completed"]);
    yield* openSideChat(orchestrator);

    const error = yield* openSideChat(orchestrator, ThreadId.make("second-side-chat")).pipe(
      Effect.flip,
    );
    assert.include(String("cause" in error ? error.cause : error), "already has side chat");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses side chats outside Claude threads", () => {
  const { instanceId, layer } = sideChatLayerFor("codex");
  return Effect.gen(function* () {
    const orchestrator = yield* createSideChatParent(instanceId, ["completed"]);

    const error = yield* openSideChat(orchestrator).pipe(Effect.flip);
    assert.include(
      String("cause" in error ? error.cause : error),
      "only available in Claude threads",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("switches file reading on a side chat only", () => {
  const { instanceId, layer } = sideChatLayerFor("claudeAgent");
  return Effect.gen(function* () {
    const orchestrator = yield* createSideChatParent(instanceId, ["completed"]);
    yield* openSideChat(orchestrator);
    yield* orchestrator.dispatch({
      type: "thread.side-chat.read-files.set",
      commandId: CommandId.make("side-chat-read-files-on"),
      threadId: sideChatThreadId,
      canReadFiles: true,
    });
    const sideChat = (yield* orchestrator.getThreadProjection(sideChatThreadId)).thread;
    assert.deepEqual(sideChat.sideChat, { canReadFiles: true });

    const error = yield* orchestrator
      .dispatch({
        type: "thread.side-chat.read-files.set",
        commandId: CommandId.make("parent-read-files-on"),
        threadId: sideChatParentThreadId,
        canReadFiles: true,
      })
      .pipe(Effect.flip);
    assert.include(String("cause" in error ? error.cause : error), "is not a side chat");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a side chat on its provider instance", () => {
  const { instanceId, layer } = sideChatLayerFor("claudeAgent");
  return Effect.gen(function* () {
    const orchestrator = yield* createSideChatParent(instanceId, ["completed"]);
    yield* openSideChat(orchestrator);

    const error = yield* orchestrator
      .dispatch({
        type: "provider.switch",
        commandId: CommandId.make("side-chat-provider-switch"),
        threadId: sideChatThreadId,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      })
      .pipe(Effect.flip);
    assert.include(
      String("cause" in error ? error.cause : error),
      "cannot switch to another provider",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("deletes the side chat once its parent settles", () => {
  const { instanceId, layer } = sideChatLayerFor("claudeAgent");
  return Effect.gen(function* () {
    const orchestrator = yield* createSideChatParent(instanceId, ["completed"]);
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* openSideChat(orchestrator);

    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle-side-chat-parent"),
      threadId: sideChatParentThreadId,
    });
    yield* worker.drain();

    const sideChat = (yield* orchestrator.getThreadProjection(sideChatThreadId)).thread;
    assert.isNotNull(sideChat.deletedAt);
    const parent = (yield* orchestrator.getThreadProjection(sideChatParentThreadId)).thread;
    assert.isNull(parent.deletedAt);
  }).pipe(Effect.provide(layer));
});
