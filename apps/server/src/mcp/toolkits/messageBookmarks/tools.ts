import {
  MessageBookmark,
  MessageBookmarksInput,
  MessageBookmarkTarget,
  MessageBookmarkRenameInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as MessageBookmarks from "../../../orchestration-v2/MessageBookmarks.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    MessageBookmarks.MessageBookmarks,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
const list = Tool.make("t3_message_bookmarks", {
  ...common,
  description:
    "List all saved message bookmarks in a thread, including their message identities and editable titles.",
  parameters: MessageBookmarksInput,
  success: Schema.Struct({ bookmarks: Schema.Array(MessageBookmark) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const add = Tool.make("t3_message_bookmark_add", {
  ...common,
  description:
    "Bookmark a user or assistant message in a thread. Saves immediately with a short fallback title, then generates a title with the configured text generation model. Adding an existing bookmark leaves its title unchanged. There is no per-thread bookmark limit.",
  parameters: MessageBookmarkTarget,
  success: Schema.Struct({}),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const rename = Tool.make("t3_message_bookmark_rename", {
  ...common,
  description:
    "Rename a message bookmark. The chosen title takes precedence over any pending generated title.",
  parameters: MessageBookmarkRenameInput,
  success: Schema.Struct({}),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const remove = Tool.make("t3_message_bookmark_remove", {
  ...common,
  description: "Remove a saved message bookmark without changing the message.",
  parameters: MessageBookmarkTarget,
  success: Schema.Struct({}),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
export const MessageBookmarksToolkit = Toolkit.make(list, add, rename, remove);
