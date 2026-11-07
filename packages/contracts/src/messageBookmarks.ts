import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { AssistantCitation } from "./assistantCitations.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";

/**
 * A whole-message bookmark as agents see it. Agent tools only ever list, add, rename, and
 * remove these; text and page bookmarks are web and desktop only, so this shape and the
 * agent tool inputs below stay unchanged.
 */
export const MessageBookmark = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  createdAt: IsoDateTime,
});
export type MessageBookmark = typeof MessageBookmark.Type;
export const MessageBookmarkTarget = Schema.Struct({ threadId: ThreadId, messageId: MessageId });
export const MessageBookmarkRenameInput = Schema.Struct({
  ...MessageBookmarkTarget.fields,
  title: MessageBookmark.fields.title,
});

/** A whole-message bookmark's id is its message id, so agent tools can address it by message. */
export const MessageBookmarkId = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
export type MessageBookmarkId = typeof MessageBookmarkId.Type;
export const MessageBookmarkPageRender = Schema.Struct({
  attachmentId: Schema.String,
  title: Schema.String,
  height: Schema.Number,
  heights: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]))),
});
/** Same anchor as an assistant citation, so the chat can find and highlight it again. */
export const MessageBookmarkTextSelection = Schema.Struct({
  text: AssistantCitation.fields.text,
  start: AssistantCitation.fields.start,
  end: AssistantCitation.fields.end,
  prefix: AssistantCitation.fields.prefix,
  suffix: AssistantCitation.fields.suffix,
});
const WholeMessageTarget = Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId });
const TextSelectionTarget = Schema.Struct({
  type: Schema.Literal("text"),
  messageId: MessageId,
  selection: MessageBookmarkTextSelection,
});
/** Any bookmark in a chat: a whole message, a piece of text in one, or one inline page. */
export const SavedMessageBookmark = Schema.Struct({
  id: MessageBookmarkId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  title: MessageBookmark.fields.title,
  createdAt: IsoDateTime,
  target: Schema.Union([
    WholeMessageTarget,
    TextSelectionTarget,
    Schema.Struct({
      type: Schema.Literal("page"),
      itemId: TurnItemId,
      htmlRender: MessageBookmarkPageRender,
    }),
  ]),
});
export type SavedMessageBookmark = typeof SavedMessageBookmark.Type;
export const MessageBookmarkAddInput = Schema.Struct({
  threadId: ThreadId,
  target: Schema.Union([
    WholeMessageTarget,
    TextSelectionTarget,
    Schema.Struct({ type: Schema.Literal("page"), itemId: TurnItemId }),
  ]),
});
export type MessageBookmarkAddInput = typeof MessageBookmarkAddInput.Type;
export const MessageBookmarkRef = Schema.Struct({
  threadId: ThreadId,
  bookmarkId: MessageBookmarkId,
});
export type MessageBookmarkRef = typeof MessageBookmarkRef.Type;
export const MessageBookmarkRefRenameInput = Schema.Struct({
  ...MessageBookmarkRef.fields,
  title: MessageBookmark.fields.title,
});
export type MessageBookmarkRefRenameInput = typeof MessageBookmarkRefRenameInput.Type;

export const MessageBookmarkExchangeMessage = Schema.Struct({
  type: Schema.Literal("message"),
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.Array(Schema.Struct({ id: ChatAttachmentId, name: Schema.String })),
  createdAt: IsoDateTime,
});
export type MessageBookmarkExchangeMessage = typeof MessageBookmarkExchangeMessage.Type;
/** An inline HTML page the agent showed during the exchange. */
export const MessageBookmarkExchangePage = Schema.Struct({
  type: Schema.Literal("page"),
  itemId: TurnItemId,
  htmlRender: MessageBookmarkPageRender,
  createdAt: IsoDateTime,
});
export type MessageBookmarkExchangePage = typeof MessageBookmarkExchangePage.Type;
/** Read only while the bookmarks panel is open, for whole-message bookmarks. */
export const MessageBookmarkWithExchange = Schema.Struct({
  bookmarkId: MessageBookmarkId,
  /** What the chat shows for the bookmarked message's exchange once its turns end, in order. */
  entries: Schema.Array(
    Schema.Union([MessageBookmarkExchangeMessage, MessageBookmarkExchangePage]),
  ),
});
export type MessageBookmarkWithExchange = typeof MessageBookmarkWithExchange.Type;
export const MessageBookmarksInput = Schema.Struct({ threadId: ThreadId });
export class MessageBookmarkError extends Schema.TaggedError<MessageBookmarkError>()(
  "MessageBookmarkError",
  {
    reason: Schema.Literals([
      "storage",
      "message-not-found",
      "bookmark-not-found",
      "turn-not-completed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "message-not-found") return "This message is no longer available.";
    if (this.reason === "bookmark-not-found") return "This bookmark no longer exists.";
    if (this.reason === "turn-not-completed")
      return "Only messages from turns that finished can be bookmarked.";
    return "Could not update message bookmarks.";
  }
}

export type MessageBookmarksInput = typeof MessageBookmarksInput.Type;

export type MessageBookmarkTarget = typeof MessageBookmarkTarget.Type;

export type MessageBookmarkRenameInput = typeof MessageBookmarkRenameInput.Type;
