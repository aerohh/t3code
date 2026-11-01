import { MessageBookmarksPopover } from "./MessageBookmarks";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { SideChatThread } from "@t3tools/client-runtime/state/threads";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  SIDE_CHAT_DEFAULT_TITLE,
  SIDE_CHAT_LIMIT,
  type ThreadId,
} from "@t3tools/contracts";
import { MessageCircleIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn, newMessageId, newThreadId } from "~/lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePanelPresence } from "../../panelAnimations";
import { selectSideChatCardOpen, useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, useSideChatThreads, waitForThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ThreadPaneContext } from "../../threadPaneContext";
import { Button } from "../ui/button";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useChatCanvas } from "./ChatCanvasContext";

/**
 * Opening, starting and closing the side chat card of one parent chat, and its tabs. The card
 * only starts a side chat when the user asks for one; it never starts one on its own.
 */
export function useSideChatCard(parentRef: ScopedThreadRef | null) {
  const sideChats = useSideChatThreads(parentRef);
  const cardOpen = useRightPanelStore((state) =>
    selectSideChatCardOpen(state.threadPanelVisibilityByThreadKey, parentRef),
  );
  const parentKey = parentRef ? scopedThreadKey(parentRef) : null;
  const rememberedTab = useRightPanelStore((state) =>
    parentKey === null ? undefined : state.sideChatTabByThreadKey[parentKey],
  );
  const openSideChat = useOrchestrationCommand(threadEnvironment.openSideChat, {
    reportFailure: false,
  });
  const deleteSideChat = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const startSideChatTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const [startingForParentKey, setStartingForParentKey] = useState<string | null>(null);
  const starting = startingForParentKey !== null && startingForParentKey === parentKey;
  const open = cardOpen && (sideChats.length > 0 || starting);
  // A closed or deleted tab falls back to the newest side chat.
  const selectedSideChat =
    sideChats.find((sideChat) => sideChat.id === rememberedTab) ?? sideChats.at(-1) ?? null;

  // The side chats go away when their parent is settled, archived or deleted, maybe on another
  // device. Close the card with them so its saved flag does not outlive them.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- side chats are server data that can vanish from another device; the saved card flag follows them
  useEffect(() => {
    if (parentRef === null || !cardOpen || sideChats.length > 0 || starting) return;
    useRightPanelStore.getState().setSideChatCardOpen(parentRef, false);
  }, [cardOpen, parentRef, sideChats.length, starting]);

  const close = () => {
    if (parentRef === null) return;
    useRightPanelStore.getState().setSideChatCardOpen(parentRef, false);
  };

  /** Resolves the new side chat's id once it reached this app, or null when it did not. */
  const startSideChat = async (ref: ScopedThreadRef): Promise<ThreadId | null> => {
    setStartingForParentKey(scopedThreadKey(ref));
    const newSideChatThreadId = newThreadId();
    useRightPanelStore.getState().setSideChatTab(ref, newSideChatThreadId);
    const result = await openSideChat({
      environmentId: ref.environmentId,
      input: { parentThreadId: ref.threadId, sideChatThreadId: newSideChatThreadId },
    });
    if (result._tag === "Failure") {
      setStartingForParentKey(null);
      if (isAtomCommandInterrupted(result)) return null;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't start a side chat",
        description: error instanceof Error ? error.message : "Something went wrong.",
      });
      return null;
    }
    const ready = await waitForThreadShell(scopeThreadRef(ref.environmentId, newSideChatThreadId));
    setStartingForParentKey(null);
    if (!ready) {
      toastManager.add({
        type: "error",
        title: "Side chat is still on its way",
        description: "It was started but hasn't reached this app yet. Try opening it again.",
      });
      return null;
    }
    return newSideChatThreadId;
  };

  const toggle = async () => {
    if (parentRef === null) return;
    if (open) {
      close();
      return;
    }
    useRightPanelStore.getState().setSideChatCardOpen(parentRef, true);
    if (sideChats.length > 0) return;
    await startSideChat(parentRef);
  };

  const canStartAnother = !starting && sideChats.length < SIDE_CHAT_LIMIT;
  const startAnother = async () => {
    if (parentRef === null || !canStartAnother) return;
    await startSideChat(parentRef);
  };

  /**
   * `/btw` from the parent's message box: opens the card on a new side chat and sends it
   * `prompt`. Resolves false when nothing was sent, so the parent keeps its draft.
   */
  const startWithQuestion = async (prompt: string): Promise<boolean> => {
    if (parentRef === null || !canStartAnother) return false;
    useRightPanelStore.getState().setSideChatCardOpen(parentRef, true);
    const sideChatThreadId = await startSideChat(parentRef);
    if (sideChatThreadId === null) return false;
    if (prompt === "") return true;
    const sideChat = readThreadShell(scopeThreadRef(parentRef.environmentId, sideChatThreadId));
    if (sideChat === null) return false;
    const turn = await startSideChatTurn({
      environmentId: parentRef.environmentId,
      input: {
        threadId: sideChatThreadId,
        message: { messageId: newMessageId(), role: "user", text: prompt, attachments: [] },
        runtimeMode: sideChat.runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      },
    });
    if (turn._tag !== "Failure") return true;
    // An empty side chat would hold one of the few slots; the question stays in the parent's draft.
    void deleteSideChat({
      environmentId: parentRef.environmentId,
      input: { threadId: sideChatThreadId },
    });
    if (!isAtomCommandInterrupted(turn)) {
      const error = squashAtomCommandFailure(turn);
      toastManager.add({
        type: "error",
        title: "Couldn't send to the side chat",
        description: error instanceof Error ? error.message : "Something went wrong.",
      });
    }
    return false;
  };

  const selectTab = (sideChatThreadId: ThreadId) => {
    if (parentRef === null) return;
    useRightPanelStore.getState().setSideChatTab(parentRef, sideChatThreadId);
  };

  const deleteTab = async (sideChatThreadId: ThreadId) => {
    if (parentRef === null) return;
    const result = await deleteSideChat({
      environmentId: parentRef.environmentId,
      input: { threadId: sideChatThreadId },
    });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Couldn't close the side chat",
      description: error instanceof Error ? error.message : "Something went wrong.",
    });
  };

  return {
    open,
    sideChats,
    // Hidden while a side chat is starting, so the card shows that instead of the old one.
    selectedSideChatThreadId: starting ? null : (selectedSideChat?.id ?? null),
    canStartAnother,
    toggle,
    close,
    startAnother,
    startWithQuestion,
    selectTab,
    deleteTab,
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
  environmentId,
  sideChats,
  selectedSideChatThreadId,
  canStartAnother,
  onSelectTab,
  onDeleteTab,
  onStartAnother,
  onClose,
  children,
}: {
  open: boolean;
  /** The parent asks its questions and approvals in the message box this card covers. */
  parentNeedsAttention: boolean;
  environmentId: EnvironmentId;
  sideChats: ReadonlyArray<SideChatThread>;
  /** Null while a side chat is being started. */
  selectedSideChatThreadId: ThreadId | null;
  canStartAnother: boolean;
  onSelectTab: (sideChatThreadId: ThreadId) => void;
  onDeleteTab: (sideChatThreadId: ThreadId) => void;
  onStartAnother: () => void;
  onClose: () => void;
  /** The chosen side chat itself, shown once it exists. */
  children: ReactNode;
}) {
  const canvas = useChatCanvas();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { animated, present } = useSideChatPresence(open);
  if (!present) return null;
  const canvasHeight = canvas?.container.height ?? 0;
  const topInset = canvas?.findBarTopInset ?? 0;
  const height =
    canvasHeight > 0
      ? `${Math.min(Math.round(canvasHeight * 0.6), canvasHeight - topInset - 40)}px`
      : "60vh";
  const sideChatRef =
    selectedSideChatThreadId === null
      ? null
      : scopeThreadRef(environmentId, selectedSideChatThreadId);
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
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 py-2 pr-2 pl-3">
          <div
            role="tablist"
            aria-label="Side chats"
            className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {sideChats.map((sideChat, index) => (
              <SideChatTab
                key={sideChat.id}
                title={sideChatTabTitle(sideChat, index)}
                selected={sideChat.id === selectedSideChatThreadId}
                canDelete={canOperate}
                onSelect={() => onSelectTab(sideChat.id)}
                onDelete={() => onDeleteTab(sideChat.id)}
              />
            ))}
          </div>
          {canOperate ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="New side chat"
                  disabled={!canStartAnother}
                  onClick={onStartAnother}
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {sideChats.length >= SIDE_CHAT_LIMIT
                  ? `Up to ${SIDE_CHAT_LIMIT} side chats. Close one to start another.`
                  : "New side chat from the main chat's latest reply"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {sideChatRef ? <MessageBookmarksPopover thread={sideChatRef} /> : null}
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

function sideChatTabTitle(sideChat: SideChatThread, index: number): string {
  return sideChat.title === SIDE_CHAT_DEFAULT_TITLE ? `Side chat ${index + 1}` : sideChat.title;
}

function SideChatTab({
  title,
  selected,
  canDelete,
  onSelect,
  onDelete,
}: {
  title: string;
  selected: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const icon = <MessageCircleIcon className="size-3" />;
  return (
    <div
      className={cn(
        "group/tab flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md pr-2 pl-1.5 text-xs",
        selected
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {canDelete ? (
        <PanelTabCloseButton
          label={`Close ${title}`}
          tooltip="Close and delete this side chat"
          onClick={onDelete}
        >
          {icon}
        </PanelTabCloseButton>
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className="min-w-0 cursor-pointer truncate"
              onClick={onSelect}
            />
          }
        >
          {title}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{title}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
