import {
  type ScreenGallery as ScreenGalleryResult,
  ScreenGalleryError,
  type ScreenGalleryInput,
} from "@t3tools/contracts";
import {
  buildScreenGallery,
  type LabelledScreenGalleryShot,
  markdownGalleryImages,
} from "@t3tools/shared/screenGallery";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class ScreenGallery extends Context.Service<
  ScreenGallery,
  {
    readonly get: (
      input: ScreenGalleryInput,
    ) => Effect.Effect<ScreenGalleryResult, ScreenGalleryError>;
  }
>()("t3/orchestration-v2/ScreenGallery") {}

const TIMELINE_PAGE_SIZE = 200;
const PUSH_HISTORY_LIMIT = 1000;

interface PushHistory {
  readonly branch: string | null;
  readonly pushTimes: ReadonlyArray<string>;
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  // A reply may name a picture relative to the thread's checkout, which the gallery cannot see.
  const resolveShotSrc = (src: string, cwd: string | null): string => {
    const isUrlOrAbsolute =
      /^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith("/") || src.startsWith("\\");
    return cwd === null || isUrlOrAbsolute ? src : path.join(cwd, src);
  };
  const storageError = (cause: unknown) => new ScreenGalleryError({ reason: "storage", cause });

  const readLabelledShots = Effect.fn("ScreenGallery.readLabelledShots")(function* (
    threadId: ScreenGalleryInput["threadId"],
    cwd: string | null,
  ) {
    const shots: LabelledScreenGalleryShot[] = [];
    let afterPosition = -1;
    while (true) {
      const page = yield* projections
        .getTimelinePage(threadId, { afterPosition, limit: TIMELINE_PAGE_SIZE })
        .pipe(Effect.mapError(storageError));
      for (const { item } of page.items) {
        if (item.type !== "assistant_message" || item.streaming) continue;
        const takenAt = DateTime.formatIso(item.completedAt ?? item.updatedAt);
        for (const image of markdownGalleryImages(item.text)) {
          shots.push({
            shot: {
              messageId: item.messageId,
              src: resolveShotSrc(image.src, cwd),
              note: image.note,
              takenAt,
            },
            screen: image.screen,
            isBefore: image.isBefore,
          });
        }
      }
      const lastPosition = page.items.at(-1)?.position;
      if (!page.hasMore || lastPosition === undefined) return shots;
      afterPosition = lastPosition;
    }
  });

  // Git logs every push made from this machine in the upstream branch's reflog, whether it came
  // from the terminal, GitHub Desktop, or T3's own Git button.
  const readPushHistory = Effect.fn("ScreenGallery.readPushHistory")(function* (input: {
    readonly cwd: string;
    readonly branch: string | null;
  }) {
    const noHistory: PushHistory = { branch: null, pushTimes: [] };
    const result = yield* git
      .execute({
        operation: "ScreenGallery.readPushHistory",
        cwd: input.cwd,
        args: [
          "reflog",
          "show",
          `--max-count=${PUSH_HISTORY_LIMIT}`,
          "--date=iso-strict",
          "--format=%gd%x09%gs",
          `${input.branch ?? ""}@{upstream}`,
          "--",
        ],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("screen gallery could not read push history", {
            cwd: input.cwd,
            error,
          }).pipe(Effect.as(null)),
        ),
      );
    if (result === null || result.exitCode !== 0) return noHistory;
    let branch: string | null = null;
    const pushTimes: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const [selector, subject] = line.split("\t");
      if (subject !== "update by push" || !selector) continue;
      const match = selector.match(/^(.+)@\{(.+)\}$/);
      if (!match?.[1] || !match[2]) continue;
      branch ??= match[1];
      pushTimes.push(match[2]);
    }
    return { branch, pushTimes } satisfies PushHistory;
  });

  const get: ScreenGallery["Service"]["get"] = Effect.fn("ScreenGallery.get")(function* (input) {
    const records = yield* projections
      .getThreadRecords(input.threadId, [])
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProjectionStoreThreadNotFoundError"
            ? new ScreenGalleryError({ reason: "thread-not-found", cause })
            : storageError(cause),
        ),
      );
    if (records.thread.deletedAt !== null)
      return yield* new ScreenGalleryError({ reason: "thread-not-found" });
    const project = yield* projects
      .get(records.thread.projectId)
      .pipe(Effect.mapError(storageError));
    const cwd =
      records.thread.worktreePath ??
      Option.match(project, { onNone: () => null, onSome: (row) => row.workspaceRoot });
    const shots = yield* readLabelledShots(input.threadId, cwd);
    const pushHistory: PushHistory =
      cwd === null || shots.length === 0
        ? { branch: null, pushTimes: [] }
        : yield* readPushHistory({ cwd, branch: records.thread.branch });
    return {
      ...buildScreenGallery({ shots, pushTimes: pushHistory.pushTimes }),
      pushBranch: pushHistory.branch,
    };
  });

  return ScreenGallery.of({ get });
});

export const layer = Layer.effect(ScreenGallery, make);
