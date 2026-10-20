import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Navigate, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import ChatView from "./ChatView";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { SidebarInset } from "./ui/sidebar";
import { toastManager } from "./ui/toast";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { useComposerDraftStore } from "../composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useResizeDrag } from "../hooks/useResizeDrag";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useEnvironmentThreadRefs, useQuietThreadShell } from "../state/entities";
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
 * Unkeyed so navigating between server threads reuses one ChatView. Rendered by the `_chat`
 * layout, since an element only survives a route swap when the same parent renders it. Draft
 * promotion runs in the draft store; this only follows the redirect it leaves behind.
 * `background` keeps the thread mounted, inert and in place under Settings or Usage.
 */
export function ThreadRouteView({
  target,
  background = false,
}: {
  target: ThreadRouteTarget;
  background?: boolean;
}) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const draftRedirect = useComposerDraftStore((store) =>
    draftId === null ? null : store.getPromotedDraftRedirect(draftId),
  );
  const serverThreadRef = target.kind === "server" ? target.threadRef : null;
  const serverThreadShell = useQuietThreadShell(serverThreadRef);
  const shellStatus = useEnvironmentShellStatus(serverThreadRef?.environmentId ?? null);
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  // Reached from the sidebar before finalize, the thread still has its draft.
  const serverThreadDraftId = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftIdByRef(serverThreadRef) : null,
  );
  const threadPair = useThreadPairStore((store) =>
    target.kind === "server" ? findThreadPair(store.pairs, target.threadRef) : null,
  );
  const [insetElement, setInsetElement] = useState<HTMLElement | null>(null);
  const insetWidth = useElementWidth(insetElement);
  // The ChatView that carried a draft keeps its key through the redirect to its thread, and only
  // until the route leaves that thread, so later visits reuse the shared unkeyed ChatView.
  const [handoffKey, setHandoffKey] = useState<{ threadKey: string; key: string } | null>(null);
  const nextHandoffKey =
    draftId !== null && draftSession === null && draftRedirect
      ? handoffKey?.key === draftId
        ? handoffKey
        : { threadKey: scopedThreadKey(draftRedirect), key: draftId }
      : serverThreadRef && handoffKey?.threadKey === scopedThreadKey(serverThreadRef)
        ? handoffKey
        : serverThreadRef && serverThreadDraftId
          ? { threadKey: scopedThreadKey(serverThreadRef), key: serverThreadDraftId }
          : null;
  if (nextHandoffKey !== handoffKey) {
    setHandoffKey(nextHandoffKey);
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
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears pending file drops and navigates the router home once a server thread is confirmed missing
  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads && !background) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [background, bootstrapComplete, environmentHasAnyThreads, navigate, renderState, target]);

  let view: React.ReactNode = null;
  let redirect: React.ReactNode = null;
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
    } else if (draftRedirect) {
      // Same slot and key as the server route renders, so the swap keeps this instance.
      view = (
        <ChatView
          key={target.draftId}
          environmentId={draftRedirect.environmentId}
          threadId={draftRedirect.threadId}
          routeKind="server"
        />
      );
      redirect = (
        <Navigate
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(draftRedirect)}
          replace
        />
      );
    } else {
      redirect = <Navigate to="/" replace />;
    }
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    const singleChatView = (
      <ChatView
        key={nextHandoffKey?.key}
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the desktop window's minimum width while a pair is on screen
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that closes the pair once the window stays too narrow for both chats
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
      inert={background}
    >
      <BackgroundThreadContext value={background}>{view}</BackgroundThreadContext>
      {background ? null : redirect}
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
      bounds: { min: THREAD_PAIR_MIN_CHAT_WIDTH, max: maxLeftWidth },
      resize(value) {
        container.style.setProperty(THREAD_PAIR_LEFT_WIDTH_PROPERTY, `${value}px`);
        return value;
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resize observer on the chat area while it is mounted
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
