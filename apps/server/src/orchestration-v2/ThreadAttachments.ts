import {
  type OrchestrationV2ConversationMessage,
  PastedTextAttachmentSource,
  type ThreadAttachmentEntry,
  type ThreadAttachments as ThreadAttachmentsResult,
  ThreadAttachmentsError,
  type ThreadAttachmentsInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ThreadAttachments extends Context.Service<
  ThreadAttachments,
  {
    readonly list: (
      input: ThreadAttachmentsInput,
    ) => Effect.Effect<ThreadAttachmentsResult, ThreadAttachmentsError>;
  }
>()("t3/orchestration-v2/ThreadAttachments") {}

const isPastedTextSource = Schema.is(PastedTextAttachmentSource);

/** Expects messages oldest first; returns one entry per name and size, newest first. */
function groupThreadAttachments(
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "attachments" | "createdAt">>,
): ReadonlyArray<ThreadAttachmentEntry> {
  const entriesByNameAndSize = new Map<string, ThreadAttachmentEntry>();
  for (const message of messages) {
    const attachedAt = DateTime.formatIso(message.createdAt);
    for (const attachment of message.attachments) {
      if (attachment.type !== "image" && attachment.type !== "file") continue;
      const kind =
        "source" in attachment && isPastedTextSource(attachment.source)
          ? "pasted-text"
          : attachment.mimeType.toLowerCase().startsWith("image/")
            ? "image"
            : "file";
      const key = `${attachment.name}\u0000${attachment.sizeBytes}`;
      const earlier = entriesByNameAndSize.get(key);
      entriesByNameAndSize.set(key, {
        id: attachment.id,
        kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        lastAttachedAt: attachedAt,
        timesAttached: (earlier?.timesAttached ?? 0) + 1,
      });
    }
  }
  return [...entriesByNameAndSize.values()].toSorted((left, right) =>
    right.lastAttachedAt.localeCompare(left.lastAttachedAt),
  );
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const storageError = (cause: unknown) => new ThreadAttachmentsError({ reason: "storage", cause });

  const list: ThreadAttachments["Service"]["list"] = Effect.fn("ThreadAttachments.list")(
    function* (input) {
      const records = yield* projections
        .getThreadRecords(input.threadId, [])
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProjectionStoreThreadNotFoundError"
              ? new ThreadAttachmentsError({ reason: "thread-not-found", cause })
              : storageError(cause),
          ),
        );
      if (records.thread.deletedAt !== null)
        return yield* new ThreadAttachmentsError({ reason: "thread-not-found" });
      const messages = yield* projections
        .getVisibleUserMessagesWithAttachments(input.threadId)
        .pipe(Effect.mapError(storageError));
      return { entries: groupThreadAttachments(messages) };
    },
  );

  return ThreadAttachments.of({ list });
});

export const layer = Layer.effect(ThreadAttachments, make);
