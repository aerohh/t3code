import { MessageBookmarksPopover } from "./MessageBookmarks";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn, newThreadId } from "~/lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePanelPresence } from "../../panelAnimations";
import { selectSideChatCardOpen, useRightPanelStore } from "../../rightPanelStore";
import { useSideChatThreadId, waitForThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ThreadPaneContext } from "../../threadPaneContext";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useChatCanvas } from "./ChatCanvasContext";

/**
 * Opening, starting and closing the side chat card of one parent chat. The card only starts a
 * side chat when the user asks for one; it never starts one on its own.
 */
export function useSideChatCard(parentRef: ScopedThreadRef | null) {
  const sideChatThreadId = useSideChatThreadId(parentRef);
  const cardOpen = useRightPanelStore((state) =>
    selectSideChatCardOpen(state.threadPanelVisibilityByThreadKey, parentRef),
  );
  const openSideChat = useOrchestrationCommand(threadEnvironment.openSideChat, {
    reportFailure: false,
  });
  const deleteSideChat = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const [startingForParentKey, setStartingForParentKey] = useState<string | null>(null);
  const parentKey = parentRef ? scopedThreadKey(parentRef) : null;
  const starting = startingForParentKey !== null && startingForParentKey === parentKey;
  const open = cardOpen && (sideChatThreadId !== null || starting);

  // The side chat goes away when its parent is settled, archived or deleted, maybe on another
  // device. Close the card with it, or the details card would stay hidden behind nothing.
  useEffect(() => {
    if (parentRef === null || !cardOpen || sideChatThreadId !== null || starting) return;
    useRightPanelStore.getState().setSideChatCardOpen(parentRef, false);
  }, [cardOpen, parentRef, sideChatThreadId, starting]);

  const close = () => {
    if (parentRef === null) return;
    useRightPanelStore.getState().setSideChatCardOpen(parentRef, false);
  };

  const startSideChat = async (ref: ScopedThreadRef) => {
    const newSideChatThreadId = newThreadId();
    const result = await openSideChat({
      environmentId: ref.environmentId,
      input: { parentThreadId: ref.threadId, sideChatThreadId: newSideChatThreadId },
    });
    if (result._tag === "Failure") {
      setStartingForParentKey(null);
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't start a side chat",
        description: error instanceof Error ? error.message : "Something went wrong.",
      });
      return;
    }
    const ready = await waitForThreadShell(scopeThreadRef(ref.environmentId, newSideChatThreadId));
    setStartingForParentKey(null);
    if (!ready) {
      toastManager.add({
        type: "error",
        title: "Side chat is still on its way",
        description: "It was started but hasn't reached this app yet. Try opening it again.",
      });
    }
  };

  const toggle = async () => {
    if (parentRef === null) return;
    if (open) {
      close();
      return;
    }
    useRightPanelStore.getState().setSideChatCardOpen(parentRef, true);
    if (sideChatThreadId !== null) return;
    setStartingForParentKey(scopedThreadKey(parentRef));
    await startSideChat(parentRef);
  };

  // Deletes this side chat and copies the main chat again, so the new one knows the main
  // chat's latest reply. If the second step fails, opening the card later starts a new one.
  const startFresh = async () => {
    if (parentRef === null || sideChatThreadId === null || starting) return;
    setStartingForParentKey(scopedThreadKey(parentRef));
    const result = await deleteSideChat({
      environmentId: parentRef.environmentId,
      input: { threadId: sideChatThreadId },
    });
    if (result._tag === "Failure") {
      setStartingForParentKey(null);
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't start the side chat over",
        description: error instanceof Error ? error.message : "Something went wrong.",
      });
      return;
    }
    await startSideChat(parentRef);
  };

  return {
    open,
    // Hidden while a side chat is starting, so the card shows that instead of the old one.
    sideChatThreadId: starting ? null : sideChatThreadId,
    toggle,
    close,
    startFresh,
  };
}

const SIDE_CHAT_CARD_ANIMATION_MS = 150;

/**
 * Like other popups, it animates whatever the panel animation setting says: that setting guards
 * against costly size changes, and a fade and short slide do not resize anything. It stays
 * mounted while it animates out, so closing animates too.
 */
function useSideChatPresence(open: boolean) {
  const animated = !useMediaQuery("(prefers-reduced-motion: reduce)");
  const { present } = usePanelPresence(open, true, animated, null, SIDE_CHAT_CARD_ANIMATION_MS);
  return { animated, present };
}

/** Fades the parent chat while its side chat is open. It does not block scrolling. */
export function SideChatBackdrop({ open }: { open: boolean }) {
  const { animated, present } = useSideChatPresence(open);
  if (!present) return null;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-10 bg-background/50",
        animated && "transition-opacity ease-out starting:opacity-0",
        !open && "opacity-0",
      )}
      style={animated ? { transitionDuration: `${SIDE_CHAT_CARD_ANIMATION_MS}ms` } : undefined}
    />
  );
}

/** Rises out of the parent's message box and covers it, so one box is on screen at a time. */
export function SideChatCard({
  open,
  parentNeedsAttention,
  sideChatRef,
  onClose,
  onStartFresh,
  children,
}: {
  open: boolean;
  /** The parent asks its questions and approvals in the message box this card covers. */
  parentNeedsAttention: boolean;
  /** Null while the side chat is being started. */
  sideChatRef: ScopedThreadRef | null;
  onClose: () => void;
  onStartFresh: () => void;
  /** The side chat itself, shown once it exists. */
  children: ReactNode;
}) {
  const canvas = useChatCanvas();
  const { animated, present } = useSideChatPresence(open);
  if (!present) return null;
  const canvasHeight = canvas?.container.height ?? 0;
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const height =
    canvasHeight > 0
      ? `${Math.min(Math.round(canvasHeight * 0.6), canvasHeight - topInset - 40)}px`
      : "60vh";
  return (
    <aside
      aria-label="Side chat"
      inert={!open}
      className={cn(
        "absolute inset-x-0 z-20 flex",
        "bottom-[calc(env(safe-area-inset-bottom)+1rem)] sm:bottom-[calc(env(safe-area-inset-bottom)+1.25rem)]",
        animated &&
          "transition-[opacity,translate] ease-out starting:translate-y-4 starting:opacity-0",
        !open && "pointer-events-none translate-y-4 opacity-0",
      )}
      style={{
        height,
        ...(animated ? { transitionDuration: `${SIDE_CHAT_CARD_ANIMATION_MS}ms` } : {}),
      }}
      data-side-chat-card
    >
      <div className="isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-lg">
        <div className="flex shrink-0 items-center gap-3 border-b border-border/60 py-2 pr-2 pl-4">
          <span className="text-sm font-medium text-foreground">Side chat</span>
          <div className="ml-auto flex items-center gap-1">
            {sideChatRef ? <MessageBookmarksPopover thread={sideChatRef} /> : null}
            {sideChatRef ? (
              <SideChatStartFreshButton sideChatRef={sideChatRef} onStartFresh={onStartFresh} />
            ) : null}
            <Button variant="ghost" size="icon-xs" aria-label="Close side chat" onClick={onClose}>
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        {parentNeedsAttention ? (
          <div className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-warning/10 py-1.5 pr-2 pl-4 text-xs text-foreground">
            The main chat is waiting for your answer.
            <Button className="ml-auto" variant="outline" size="xs" onClick={onClose}>
              Back to main chat
            </Button>
          </div>
        ) : null}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {sideChatRef ? (
            <ThreadPaneContext value={{ side: null, isActivePane: open, closePair: () => {} }}>
              {children}
            </ThreadPaneContext>
          ) : (
            <p className="m-auto text-sm text-muted-foreground">Starting side chat…</p>
          )}
        </div>
      </div>
    </aside>
  );
}

function SideChatStartFreshButton({
  sideChatRef,
  onStartFresh,
}: {
  sideChatRef: ScopedThreadRef;
  onStartFresh: () => void;
}) {
  const canOperate = useEnvironmentScope(sideChatRef.environmentId, AuthOrchestrationOperateScope);
  if (!canOperate) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Start side chat over"
            onClick={onStartFresh}
          />
        }
      >
        <RotateCcwIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Start over from the main chat's latest reply. This side chat is deleted.
      </TooltipPopup>
    </Tooltip>
  );
}
