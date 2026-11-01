import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadSummary,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadSummaryGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSummaryService from "./ThreadSummaryService.ts";

const threadId = ThreadId.make("thread:summary");
const firstRunId = RunId.make("run:summary:1");
const latestRunId = RunId.make("run:summary:2");
const previousSummary: OrchestrationV2ThreadSummary = {
  about: "Fixing the login loop.",
  verdict: "Cause not found yet.",
  stillOpen: ["Find the cause"],
};

function runSummary(thread: Record<string, unknown>) {
  const requests: Array<ThreadSummaryGenerationInput> = [];
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const records = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:summary"),
      title: "Login loop",
      worktreePath: null,
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      summary: previousSummary,
      ...thread,
    },
    runs: [
      { id: latestRunId, ordinal: 2, status: "completed", userMessageId: "message:user:2" },
      { id: firstRunId, ordinal: 1, status: "completed", userMessageId: "message:user:1" },
    ],
  };
  const layer = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: (_threadId, _fields, options) =>
        Effect.succeed({
          ...records,
          messages:
            options?.messageIds !== undefined
              ? [
                  { id: "message:user:1", text: "The login page loops forever." },
                  { id: "message:user:2", text: "Did the fix work?" },
                ]
              : [
                  {
                    text: "Found it: the cookie was saved for the wrong address.",
                    streaming: false,
                  },
                  { text: "Fixed and tested locally.", streaming: false },
                  { text: "Still typing", streaming: true },
                ],
        } as never),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeedSome({ workspaceRoot: "/repo" } as never),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadSummary: (input) =>
        Effect.sync(() => {
          requests.push(input);
          return { about: "Fixing the login loop.", verdict: "Fixed and tested.", stillOpen: [] };
        }),
    }),
    ServerSettings.layerTest(),
  );
  return ThreadSummaryService.make.pipe(
    Effect.flatMap((service) => service.summarizeRun(threadId, latestRunId)),
    Effect.as({ requests, dispatched }),
    Effect.provide(layer),
  );
}

it.effect("updates the summary from the previous one and only the newest exchange", () =>
  Effect.gen(function* () {
    const { requests, dispatched } = yield* runSummary({});
    assert.equal(requests.length, 1);
    assert.deepInclude(requests[0], {
      cwd: "/repo",
      title: "Login loop",
      firstUserMessage: "The login page loops forever.",
      previousSummary,
      latestUserMessage: "Did the fix work?",
      latestReply:
        "Found it: the cookie was saved for the wrong address.\n\nFixed and tested locally.",
    });
    assert.deepEqual(dispatched, [
      {
        type: "thread.summary.set",
        commandId: `server:thread-summary:${threadId}:${latestRunId}`,
        threadId,
        summary: { about: "Fixing the login loop.", verdict: "Fixed and tested.", stillOpen: [] },
      },
    ] as never);
  }),
);

it.effect("leaves side chats and delegated task chats without a summary", () =>
  Effect.gen(function* () {
    for (const thread of [
      { sideChat: {} },
      {
        lineage: {
          parentThreadId: ThreadId.make("thread:parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("thread:parent"),
        },
      },
    ]) {
      const { requests, dispatched } = yield* runSummary(thread);
      assert.equal(requests.length, 0);
      assert.equal(dispatched.length, 0);
    }
  }),
);
