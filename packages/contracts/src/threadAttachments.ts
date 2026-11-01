import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";

/**
 * One file the user attached to the thread. Copies with the same name and size count as the same
 * file, because every attach stores a fresh copy under a new id.
 */
export const ThreadAttachmentEntry = Schema.Struct({
  /** The newest copy, which is the one that opens. */
  id: ChatAttachmentId,
  kind: Schema.Literals(["image", "file", "pasted-text"]),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: NonNegativeInt,
  lastAttachedAt: IsoDateTime,
  timesAttached: PositiveInt,
});
export type ThreadAttachmentEntry = typeof ThreadAttachmentEntry.Type;

export const ThreadAttachments = Schema.Struct({
  /** Newest first. */
  entries: Schema.Array(ThreadAttachmentEntry),
});
export type ThreadAttachments = typeof ThreadAttachments.Type;

export const ThreadAttachmentsInput = Schema.Struct({ threadId: ThreadId });
export type ThreadAttachmentsInput = typeof ThreadAttachmentsInput.Type;

export class ThreadAttachmentsError extends Schema.TaggedError<ThreadAttachmentsError>()(
  "ThreadAttachmentsError",
  {
    reason: Schema.Literals(["storage", "thread-not-found"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "thread-not-found") return "This thread is no longer available.";
    return "Could not load this thread's attachments.";
  }
}
