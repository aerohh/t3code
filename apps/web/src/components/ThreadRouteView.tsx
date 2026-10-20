import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import ChatView from "./ChatView";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import { toastManager } from "./ui/toast";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useResizeDrag } from "../hooks/useResizeDrag";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useEnvironmentThreadRefs, useThreadRefs, useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";
import {
  findThreadPair,
  THREAD_PAIR_MIN_CHAT_WIDTH,
  THREAD_PAIR_MIN_TOTAL_WIDTH,
  type ThreadPair,
  useThreadPairStore,
} from "../threadPairStore";
import { ThreadPaneContext } from "../threadPaneContext";

/**
 * Plain server threads are unkeyed, so navigating between them reuses one instance as ChatView
 * expects. Rendered by the `_chat` layout rather than by the two leaf routes, since an element
 * only survives a route swap when the same parent renders it.
 */
export function ThreadRouteView({ target }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  // Promotion can begin before the server creates the reserved thread.
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : inferredThreadRef;
  const serverThread = useQuietThreadShell(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending,
        })
      : null;

  const shellStatus = useEnvironmentShellStatus(serverThreadRef?.environmentId ?? null);
  const serverThreadShell = serverThread;
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  const threadPair = useThreadPairStore((store) =>
    target.kind === "server" ? findThreadPair(store.pairs, target.threadRef) : null,
  );
  const [insetElement, setInsetElement] = useState<HTMLElement | null>(null);
  const insetWidth = useElementWidth(insetElement);
  // The draft record is removed once the promoted thread has started, which
  // is after the route swap. Latch the key so the element that carried the
  // draft keeps its identity for as long as this thread stays on screen.
  const [chatViewKey, setChatViewKey] = useState<{ threadKey: string; key: string } | null>(null);
  const serverThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const nextChatViewKey =
    serverThreadKey === null
      ? null
      : chatViewKey?.threadKey === serverThreadKey
        ? chatViewKey
        : promotedDraftId
          ? { threadKey: serverThreadKey, key: promotedDraftId }
          : null;
  if (nextChatViewKey !== chatViewKey) {
    setChatViewKey(nextChatViewKey);
  }
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  // Until the shell lists the thread, its own load (HTTP, then the socket)
  // decides whether it exists. Read only then: once listed, ChatView keeps
  // this stream open and its updates need not re-render the route.
  const unlistedThreadRef =
    target.kind === "server" && serverThreadShell === null && draftThread === null
      ? target.threadRef
      : null;
  const unlistedThreadDetail = useEnvironmentThread(
    unlistedThreadRef?.environmentId ?? null,
    unlistedThreadRef?.threadId ?? null,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    unlistedThreadDetail,
    draftThreadExists: draftThread !== null,
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, target]);

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let view: React.ReactNode = null;
  if (target.kind === "draft") {
    if (draftSession) {
      view = (
        <ChatView
          key={target.draftId}
          draftId={target.draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          forceExpandedMobileComposer
        />
      );
    }
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    const singleChatView = (
      <ChatView
        key={nextChatViewKey?.key}
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
        routeKind="server"
      />
    );
    view =
      threadPair && (insetWidth === null || insetWidth >= THREAD_PAIR_MIN_TOTAL_WIDTH) ? (
        <ThreadPairView pair={threadPair} activeThreadRef={target.threadRef} />
      ) : (
        singleChatView
      );
  }

  const pairRequested = view !== null && threadPair !== null;
  // Everything beside the chats (the sidebar) plus two minimum-width chats, in CSS pixels.
  const minContentWidth =
    pairRequested && insetWidth !== null
      ? Math.ceil(window.innerWidth - insetWidth + THREAD_PAIR_MIN_TOTAL_WIDTH)
      : null;
  useEffect(() => {
    const setMinimumContentWidth = window.desktopBridge?.setWindowMinimumContentWidth;
    if (!setMinimumContentWidth || minContentWidth === null) return;
    void setMinimumContentWidth(minContentWidth);
    return () => void setMinimumContentWidth(null);
  }, [minContentWidth]);

  const widthWithoutRoomForPair =
    pairRequested && insetWidth !== null && insetWidth < THREAD_PAIR_MIN_TOTAL_WIDTH
      ? insetWidth
      : null;
  useEffect(() => {
    if (widthWithoutRoomForPair === null || !threadPair) return;
    // Restarted on every width change: the desktop window grows a moment after the pair asks
    // for room, and a browser window may only pass through a narrow width while being resized.
    const timer = window.setTimeout(() => {
      useThreadPairStore.getState().closePair(threadPair.left);
      toastManager.add({
        type: "info",
        title: "Side by side closed",
        description: "There isn't enough room to show both chats.",
      });
    }, THREAD_PAIR_NO_ROOM_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [threadPair, widthWithoutRoomForPair]);

  return (
    <SidebarInset
      ref={setInsetElement}
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
    >
      {view}
    </SidebarInset>
  );
}

const THREAD_PAIR_NO_ROOM_GRACE_MS = 500;
const THREAD_PAIR_SPLIT_STORAGE_KEY = "t3code:thread-pair-split:v1";
const THREAD_PAIR_LEFT_WIDTH_PROPERTY = "--thread-pair-left-width";
const SplitShareSchema = Schema.Finite;
const LEFT_PANE_WIDTH = `clamp(${THREAD_PAIR_MIN_CHAT_WIDTH}px, var(${THREAD_PAIR_LEFT_WIDTH_PROPERTY}), calc(100% - ${THREAD_PAIR_MIN_CHAT_WIDTH}px))`;

function readStoredSplitShare(): number {
  const share = getLocalStorageItem(THREAD_PAIR_SPLIT_STORAGE_KEY, SplitShareSchema);
  return share !== null && share > 0 && share < 1 ? share : 0.5;
}

/**
 * Both chats of a locked pair. The address always names the active pane, so app-wide features
 * that read the route follow whichever chat the user is working in.
 */
function ThreadPairView({
  pair,
  activeThreadRef,
}: {
  pair: ThreadPair;
  activeThreadRef: ScopedThreadRef;
}) {
  const navigate = useNavigate();
  const closePair = useThreadPairStore((store) => store.closePair);
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftShare, setLeftShare] = useState(readStoredSplitShare);
  const activeThreadKey = scopedThreadKey(activeThreadRef);

  const showThread = (threadRef: ScopedThreadRef) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
    });

  const activate = (threadRef: ScopedThreadRef) => {
    if (scopedThreadKey(threadRef) === activeThreadKey) return;
    void showThread(threadRef);
  };

  // The left chat stays on screen; switching the route first avoids flashing the right one alone.
  const closeThisPair = () => {
    void showThread(pair.left).then(() => closePair(pair.left));
  };

  const divider = useResizeDrag<HTMLDivElement>((event) => {
    const container = containerRef.current;
    const leftPane = event.currentTarget.previousElementSibling;
    if (!container || !(leftPane instanceof HTMLElement)) return null;
    const containerWidth = container.getBoundingClientRect().width;
    const maxLeftWidth = Math.max(
      THREAD_PAIR_MIN_CHAT_WIDTH,
      containerWidth - THREAD_PAIR_MIN_CHAT_WIDTH,
    );
    return {
      width: leftPane.getBoundingClientRect().width,
      edge: "right",
      resize(value) {
        const next = Math.max(THREAD_PAIR_MIN_CHAT_WIDTH, Math.min(maxLeftWidth, value));
        container.style.setProperty(THREAD_PAIR_LEFT_WIDTH_PROPERTY, `${next}px`);
        return next;
      },
      finish(finalWidth) {
        const share = finalWidth / containerWidth;
        setLeftShare(share);
        setLocalStorageItem(THREAD_PAIR_SPLIT_STORAGE_KEY, share, SplitShareSchema);
      },
      cleanup(committed) {
        if (!committed) {
          container.style.setProperty(THREAD_PAIR_LEFT_WIDTH_PROPERTY, `${leftShare * 100}%`);
        }
      },
    };
  });

  const renderPane = (side: "left" | "right", threadRef: ScopedThreadRef) => {
    const isActivePane = scopedThreadKey(threadRef) === activeThreadKey;
    return (
      <ThreadPaneContext value={{ side, isActivePane, closePair: closeThisPair }}>
        <div
          className={cn(
            // Layout containment pins each chat's fixed titlebar controls to its own pane.
            "relative flex min-h-0 min-w-0 flex-col [contain:layout]",
            // The window's native controls sit over the right pane only.
            side === "left"
              ? "flex-none [--workspace-controls-right:0.75rem] [--workspace-native-controls-inset:0px]"
              : "flex-1",
          )}
          style={side === "left" ? { width: LEFT_PANE_WIDTH } : undefined}
          data-thread-pane={side}
          data-thread-pane-active={isActivePane}
          onPointerDownCapture={() => activate(threadRef)}
        >
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            reserveTitleBarControlInset={side === "right"}
          />
          {isActivePane ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-50 h-0.5 bg-primary"
            />
          ) : null}
        </div>
      </ThreadPaneContext>
    );
  };

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1"
      style={{ [THREAD_PAIR_LEFT_WIDTH_PROPERTY]: `${leftShare * 100}%` } as React.CSSProperties}
    >
      {renderPane("left", pair.left)}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side by side chats"
        className="relative z-50 w-px shrink-0 cursor-col-resize touch-none bg-border before:absolute before:inset-y-0 before:-right-1 before:-left-1"
        onPointerDown={divider.onPointerDown}
        onPointerMove={divider.onPointerMove}
        onPointerUp={divider.onPointerUp}
        onPointerCancel={divider.onPointerCancel}
        onLostPointerCapture={divider.onLostPointerCapture}
      />
      {renderPane("right", pair.right)}
    </div>
  );
}

function useElementWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    // The observer reports the first size before paint, so no synchronous read is needed.
    return observeResize(element, (entries) => {
      const latest = entries.at(-1);
      if (latest) setWidth(latest.contentRect.width);
    });
  }, [element]);
  return width;
}
