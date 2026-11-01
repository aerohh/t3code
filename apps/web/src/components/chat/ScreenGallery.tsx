import {
  WS_METHODS,
  type ScopedThreadRef,
  type ScreenGalleryScreen,
  type ScreenGalleryShot,
} from "@t3tools/contracts";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { CameraIcon } from "lucide-react";
import { useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
} from "./ChatMarkdownMedia";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

// Dropped as soon as the gallery closes, so each open reads the chat and git push history afresh.
const screenGalleryQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:screen-gallery",
  tag: WS_METHODS.screenGalleryGet,
  idleTtlMs: 0,
});

const SHOT_MAX_HEIGHT_REM = 16;
const PUSHES_SHOWN_COLLAPSED = 2;

export function ScreenGalleryButton({ thread }: { thread: ScopedThreadRef }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Screenshot gallery"
              onClick={() => setOpen(true)}
            />
          }
        >
          <CameraIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Screenshot gallery</TooltipPopup>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-6xl">
          {open ? <ScreenGalleryContent thread={thread} /> : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

function ScreenGalleryContent({ thread }: { thread: ScopedThreadRef }) {
  const { data, error, refresh } = useEnvironmentQuery(
    screenGalleryQuery({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId },
    }),
  );
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const [unlabelledShown, setUnlabelledShown] = useState(false);

  const body = (() => {
    if (error) {
      return (
        <div role="alert" className="text-sm">
          {error}
          <Button variant="ghost" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      );
    }
    if (!data) return <p className="text-sm text-muted-foreground">Loading screenshots…</p>;
    if (data.screens.length === 0 && data.unlabelled.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          No screenshots in this chat yet. When the agent shows a labelled screenshot of a screen,
          it appears here.
        </p>
      );
    }
    return (
      <>
        <p className="text-sm text-muted-foreground">
          {data.pushBranch
            ? `Checkpoints are pushes to ${data.pushBranch} from this computer.`
            : "No pushes found for this chat's branch, so only the start and the newest screenshots are shown."}
        </p>
        {data.screens.map((screen) => (
          <ScreenRow key={screen.name} thread={thread} screen={screen} onExpand={setPreview} />
        ))}
        {data.unlabelled.length > 0 ? (
          <section className="space-y-3">
            <Button variant="ghost" size="sm" onClick={() => setUnlabelledShown((shown) => !shown)}>
              {unlabelledShown
                ? "Hide unlabelled screenshots"
                : `Show ${data.unlabelled.length} unlabelled screenshot${data.unlabelled.length === 1 ? "" : "s"}`}
            </Button>
            {unlabelledShown ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {data.unlabelled.map((shot, index) => (
                  <ShotCard
                    // oxlint-disable-next-line react/no-array-index-key -- one message can show the same picture twice, and this list only changes as a whole
                    key={`${shot.messageId}:${index}`}
                    thread={thread}
                    label={null}
                    shot={shot}
                    onExpand={setPreview}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </>
    );
  })();

  return (
    <>
      <DialogHeader>
        <DialogTitle>Screenshot gallery</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-6" data-image-gallery>
          {body}
        </div>
      </DialogPanel>
      {preview ? <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

function ScreenRow({
  thread,
  screen,
  onExpand,
}: {
  thread: ScopedThreadRef;
  screen: ScreenGalleryScreen;
  onExpand: (preview: ExpandedImagePreview) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [expanded, setExpanded] = useState(false);
  const hiddenPushCount = Math.max(0, screen.pushes.length - PUSHES_SHOWN_COLLAPSED);
  const firstShownPush = expanded ? 0 : hiddenPushCount;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">{screen.name}</h3>
        {hiddenPushCount > 0 ? (
          <Button variant="ghost" size="xs" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show fewer checkpoints" : `Show all ${screen.pushes.length} checkpoints`}
          </Button>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ShotCard thread={thread} label="Before" shot={screen.before} onExpand={onExpand} />
        {screen.pushes.slice(firstShownPush).map((push, index) => (
          <ShotCard
            key={push.pushedAt}
            thread={thread}
            label={`Push ${firstShownPush + index + 1} · ${formatDayAwareTimestamp(push.pushedAt, timestampFormat)}`}
            shot={push.shot}
            onExpand={onExpand}
          />
        ))}
        {screen.notPushedYet ? (
          <ShotCard
            thread={thread}
            label="Not pushed yet"
            shot={screen.notPushedYet}
            onExpand={onExpand}
          />
        ) : null}
      </div>
    </section>
  );
}

function ShotCard({
  thread,
  label,
  shot,
  onExpand,
}: {
  thread: ScopedThreadRef;
  label: string | null;
  shot: ScreenGalleryShot;
  onExpand: (preview: ExpandedImagePreview) => void;
}) {
  return (
    <figure className="min-w-0 space-y-1.5">
      {label ? <figcaption className="text-xs text-muted-foreground">{label}</figcaption> : null}
      <ShotImage thread={thread} shot={shot} onExpand={onExpand} />
      {shot.note ? <p className="text-sm">{shot.note}</p> : null}
    </figure>
  );
}

function ShotImage({
  thread,
  shot,
  onExpand,
}: {
  thread: ScopedThreadRef;
  shot: ScreenGalleryShot;
  onExpand: (preview: ExpandedImagePreview) => void;
}) {
  const source = classifyMarkdownImageSource(shot.src);
  const alt = shot.note || "Screenshot";
  if (source._tag === "Direct") {
    return (
      <ChatMarkdownImage
        src={source.uri}
        alt={alt}
        copyMarkdown={undefined}
        standalone
        style={{ maxHeight: `${SHOT_MAX_HEIGHT_REM}rem` }}
        actionsSource={{ kind: "image", name: alt, src: source.uri }}
        onImageExpand={onExpand}
      />
    );
  }
  if (source._tag === "WorkspaceFile") {
    return (
      <ChatMarkdownAssetImage
        environmentId={thread.environmentId}
        resource={{ _tag: "media-file", threadId: thread.threadId, path: source.path }}
        alt={alt}
        standalone
        maxHeightRem={SHOT_MAX_HEIGHT_REM}
        onImageExpand={onExpand}
      />
    );
  }
  return <ChatMarkdownImageFallback alt={alt} />;
}
