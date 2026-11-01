import { assert, it } from "@effect/vitest";
import {
  type ChatAttachment,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadAttachments from "./ThreadAttachments.ts";

const layerTest = ThreadAttachments.layer.pipe(
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("attachments-thread");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 0, minute));

const createThread = Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
  projections.apply({
    id: EventId.make(`created:${threadId}`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: at(0),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("attachments-project"),
      title: "Attachments",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at(0),
      updatedAt: at(0),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  }),
);

let nextOrdinal = 0;
// The chat shows timeline items, so each message also gets one, as in production.
const addUserMessage = (
  id: string,
  minute: number,
  attachments: ReadonlyArray<ChatAttachment>,
  runId: RunId | null = null,
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const occurredAt = at(minute);
    yield* projections.apply({
      id: EventId.make(`message:${id}`),
      type: "message.updated",
      threadId,
      providerInstanceId,
      occurredAt,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: MessageId.make(id),
        threadId,
        runId,
        nodeId: null,
        role: "user",
        text: "See attached",
        attachments,
        streaming: false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    });
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
        messageId: MessageId.make(id),
        text: "See attached",
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        attachments,
      },
    });
  });

const file = (id: string, name: string, sizeBytes: number): ChatAttachment => ({
  type: "file",
  id,
  name,
  mimeType: "application/pdf",
  sizeBytes,
});

it.effect("lists each attached file once, opening its newest copy, newest first", () =>
  Effect.gen(function* () {
    yield* createThread;
    yield* addUserMessage("first", 1, [
      file("report-a", "report.pdf", 100),
      { type: "image", id: "shot", name: "shot.png", mimeType: "image/png", sizeBytes: 50 },
    ]);
    yield* addUserMessage("second", 2, [file("report-b", "report.pdf", 100)]);
    yield* addUserMessage("third", 3, [
      file("report-edited", "report.pdf", 120),
      {
        type: "file",
        id: "paste",
        name: "pasted-1.txt",
        mimeType: "text/plain",
        sizeBytes: 9000,
        source: { _tag: "pasted-text" },
      },
    ]);
    const service = yield* ThreadAttachments.ThreadAttachments;
    const { entries } = yield* service.list({ threadId });
    assert.deepStrictEqual(
      entries.map((entry) => [entry.id, entry.kind, entry.timesAttached, entry.lastAttachedAt]),
      [
        ["report-edited", "file", 1, DateTime.formatIso(at(3))],
        ["paste", "pasted-text", 1, DateTime.formatIso(at(3))],
        ["report-b", "file", 2, DateTime.formatIso(at(2))],
        ["shot", "image", 1, DateTime.formatIso(at(1))],
      ],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves out files whose message was undone", () =>
  Effect.gen(function* () {
    yield* createThread;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runId = RunId.make("undone-run");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      providerThreadId: null,
      userMessageId: MessageId.make("undone"),
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
      threadId,
      occurredAt: at(1),
      type: "run.created",
      payload: run,
    });
    yield* addUserMessage("kept", 0, [file("kept", "kept.pdf", 10)]);
    yield* addUserMessage("undone", 1, [file("undone", "undone.pdf", 10)], runId);
    const service = yield* ThreadAttachments.ThreadAttachments;
    assert.strictEqual((yield* service.list({ threadId })).entries.length, 2);
    yield* projections.apply({
      id: EventId.make("run:undone:rolled-back"),
      threadId,
      occurredAt: at(3),
      type: "run.updated",
      payload: { ...run, status: "rolled_back" },
    });
    assert.deepStrictEqual(
      (yield* service.list({ threadId })).entries.map((entry) => entry.id),
      ["kept"],
    );
  }).pipe(Effect.provide(layerTest)),
);
