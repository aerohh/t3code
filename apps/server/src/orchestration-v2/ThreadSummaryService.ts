import { CommandId, type RunId, type ThreadId } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

/**
 * After each completed run, asks the text generation model to update the chat's
 * summary from the previous summary and the newest exchange only, so it never
 * re-reads the whole chat. Work lives in memory: a restart skips a summary that
 * was still being written, and the next completed run catches up.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const summarizeRun = Effect.fn("ThreadSummaryService.summarizeRun")(
    function* (threadId: ThreadId, runId: RunId) {
      const { thread, runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.sideChat !== undefined ||
        thread.lineage.relationshipToParent === "subagent"
      ) {
        return;
      }
      const liveRuns = runs
        .filter((run) => run.status !== "rolled_back")
        .toSorted((left, right) => left.ordinal - right.ordinal);
      const run = liveRuns.find((candidate) => candidate.id === runId);
      const firstRun = liveRuns[0];
      if (run === undefined || firstRun === undefined || run.delegatedTaskId !== undefined) return;

      const { messages: userMessages } = yield* projections.getThreadRecords(
        threadId,
        ["messages"],
        { messageIds: [firstRun.userMessageId, run.userMessageId] },
      );
      const { messages: replyMessages } = yield* projections.getThreadRecords(
        threadId,
        ["messages"],
        { messageRunIds: [runId], messageRoles: ["assistant"] },
      );
      const latestReply = replyMessages
        .filter((message) => !message.streaming)
        .map((message) => assistantCitationsToPlainText(message.text).trim())
        .filter((text) => text.length > 0)
        .join("\n\n");
      if (latestReply.length === 0) return;

      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) return;
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        thread.projectId,
      ).settings;
      const userText = (messageId: typeof run.userMessageId) =>
        userMessages.find((message) => message.id === messageId)?.text ?? "";

      const summary = yield* textGeneration.generateThreadSummary({
        cwd: thread.worktreePath ?? project.value.workspaceRoot,
        title: thread.title,
        firstUserMessage: userText(firstRun.userMessageId),
        previousSummary: thread.summary ?? null,
        latestUserMessage: userText(run.userMessageId),
        latestReply,
        modelSelection: settings.textGenerationModelSelection,
      });
      if (summary.about.length === 0 || summary.verdict.length === 0) return;

      yield* orchestrator.dispatch({
        type: "thread.summary.set",
        commandId: CommandId.make(`server:thread-summary:${threadId}:${runId}`),
        threadId,
        summary,
      });
    },
    (effect, threadId, runId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("thread summary skipped", { threadId, runId, cause }),
        ),
      ),
  );

  const start = Effect.fn("ThreadSummaryService.start")(function* () {
    // Keyed by thread: a newer completed run replaces a summary still being written.
    const inFlight = yield* FiberMap.make<ThreadId>();
    // A completed run can be reported again (for example when its checkpoint lands).
    const lastRunByThread = new Map<ThreadId, RunId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type !== "run.updated" || event.payload.status !== "completed") {
          return Effect.void;
        }
        if (lastRunByThread.get(event.threadId) === event.payload.id) return Effect.void;
        lastRunByThread.set(event.threadId, event.payload.id);
        return FiberMap.run(
          inFlight,
          event.threadId,
          summarizeRun(event.threadId, event.payload.id),
        );
      }),
    );
  });

  return { start, summarizeRun };
});
