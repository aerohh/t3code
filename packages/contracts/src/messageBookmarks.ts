import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MessageBookmark = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  createdAt: IsoDateTime,
});
export type MessageBookmark = typeof MessageBookmark.Type;
export const MessageBookmarksInput = Schema.Struct({ threadId: ThreadId });
export const MessageBookmarkTarget = Schema.Struct({ threadId: ThreadId, messageId: MessageId });
export const MessageBookmarkRenameInput = Schema.Struct({
  ...MessageBookmarkTarget.fields,
  title: MessageBookmark.fields.title,
});
export class MessageBookmarkError extends Schema.TaggedError<MessageBookmarkError>()(
  "MessageBookmarkError",
  {
    reason: Schema.Literals(["storage", "message-not-found", "bookmark-not-found"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "message-not-found") return "This message is no longer available.";
    if (this.reason === "bookmark-not-found") return "This bookmark no longer exists.";
    return "Could not update message bookmarks.";
  }
}

export type MessageBookmarksInput = typeof MessageBookmarksInput.Type;

export type MessageBookmarkTarget = typeof MessageBookmarkTarget.Type;

export type MessageBookmarkRenameInput = typeof MessageBookmarkRenameInput.Type;
