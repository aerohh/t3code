import { OrchestratorMcpFailure, type MessageBookmarkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as MessageBookmarks from "../../../orchestration-v2/MessageBookmarks.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MessageBookmarksToolkit } from "./tools.ts";

const failure = (cause: MessageBookmarkError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: cause.message });
const handlers = {
  t3_message_bookmarks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MessageBookmarks.MessageBookmarks;
      return { bookmarks: yield* service.list(input).pipe(Effect.mapError(failure)) };
    }),
  ),
  t3_message_bookmark_add: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const service = yield* MessageBookmarks.MessageBookmarks;
        return yield* service.add(input).pipe(Effect.as({}), Effect.mapError(failure));
      }),
  ),
  t3_message_bookmark_rename: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const service = yield* MessageBookmarks.MessageBookmarks;
        return yield* service.rename(input).pipe(Effect.as({}), Effect.mapError(failure));
      }),
  ),
  t3_message_bookmark_remove: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const service = yield* MessageBookmarks.MessageBookmarks;
        return yield* service.remove(input).pipe(Effect.as({}), Effect.mapError(failure));
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof MessageBookmarksToolkit.tools>;
export const layer = McpToolAccess.toLayer(MessageBookmarksToolkit, handlers);
