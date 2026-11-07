import { WS_METHODS, type RunId, type ScopedThreadRef } from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createMessageBookmarkEnvironmentAtoms } from "@t3tools/client-runtime/state/messageBookmarks";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadDetails } from "./threads";
export const messageBookmarkEnvironment =
  createMessageBookmarkEnvironmentAtoms(connectionAtomRuntime);
export const messageBookmarkMessagesQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:message-bookmark-messages",
    tag: WS_METHODS.messageBookmarksMessages,
  },
);

const NO_RUN_IDS: ReadonlySet<RunId> = new Set();

// Holds the same set until a turn starts or ends, so bookmark buttons don't
// re-render on every new tool call.
const unbookmarkableRunIdsAtomFamily = Atom.family((key: string) => {
  const thread = parseScopedThreadKey(key);
  let previousKey = "";
  let previous = NO_RUN_IDS;
  return Atom.make((get) => {
    const structure =
      thread === null ? null : get(environmentThreadDetails.quietThreadAtom(thread));
    const runIds = (structure?.projection.runs ?? []).flatMap((run) =>
      run.status === "completed" ? [] : [run.id],
    );
    const nextKey = runIds.join("\n");
    if (nextKey !== previousKey) {
      previousKey = nextKey;
      previous = new Set(runIds);
    }
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`message-bookmark-unbookmarkable-runs:${key}`));
});

/** Turns that are still running, were stopped, or failed. Their messages can't be bookmarked. */
export const unbookmarkableRunIdsAtom = (thread: ScopedThreadRef) =>
  unbookmarkableRunIdsAtomFamily(scopedThreadKey(thread));
