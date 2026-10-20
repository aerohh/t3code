import { createMessageBookmarkEnvironmentAtoms } from "@t3tools/client-runtime/state/messageBookmarks";
import { connectionAtomRuntime } from "../connection/runtime";
export const messageBookmarkEnvironment =
  createMessageBookmarkEnvironmentAtoms(connectionAtomRuntime);
