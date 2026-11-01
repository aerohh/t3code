import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ScreenGalleryShot = Schema.Struct({
  messageId: MessageId,
  src: Schema.String,
  note: Schema.String,
  takenAt: IsoDateTime,
});
export type ScreenGalleryShot = typeof ScreenGalleryShot.Type;

export const ScreenGalleryPush = Schema.Struct({
  pushedAt: IsoDateTime,
  shot: ScreenGalleryShot,
});
export type ScreenGalleryPush = typeof ScreenGalleryPush.Type;

export const ScreenGalleryScreen = Schema.Struct({
  name: TrimmedNonEmptyString,
  before: ScreenGalleryShot,
  pushes: Schema.Array(ScreenGalleryPush),
  notPushedYet: Schema.NullOr(ScreenGalleryShot),
});
export type ScreenGalleryScreen = typeof ScreenGalleryScreen.Type;

export const ScreenGallery = Schema.Struct({
  screens: Schema.Array(ScreenGalleryScreen),
  unlabelled: Schema.Array(ScreenGalleryShot),
  /** The remote branch whose pushes became checkpoints, or null when git has no push history. */
  pushBranch: Schema.NullOr(TrimmedNonEmptyString),
});
export type ScreenGallery = typeof ScreenGallery.Type;

export const ScreenGalleryInput = Schema.Struct({ threadId: ThreadId });
export type ScreenGalleryInput = typeof ScreenGalleryInput.Type;

export class ScreenGalleryError extends Schema.TaggedError<ScreenGalleryError>()(
  "ScreenGalleryError",
  {
    reason: Schema.Literals(["storage", "thread-not-found"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "thread-not-found") return "This thread is no longer available.";
    return "Could not load the screenshot gallery.";
  }
}
