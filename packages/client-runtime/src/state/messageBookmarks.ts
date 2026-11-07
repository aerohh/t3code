import { WS_METHODS, type RunId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createMessageBookmarkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:message-bookmarks",
      tag: WS_METHODS.messageBookmarksSubscribe,
    }),
    add: createEnvironmentRpcCommand(runtime, {
      label: "bookmark message",
      tag: WS_METHODS.messageBookmarksAdd,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "rename bookmark",
      tag: WS_METHODS.messageBookmarksRename,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "remove bookmark",
      tag: WS_METHODS.messageBookmarksRemove,
    }),
  };
}

/**
 * Navigation stays local to the client and is scoped to the destination environment. The entry is
 * the timeline row to reveal: a message id, or the turn item id of an inline page.
 */
export const messageBookmarkNavigation = Atom.family((_threadKey: string) =>
  Atom.make<{
    target: { entryId: string; runId: RunId | null };
    requestId: number;
  } | null>(null),
);
