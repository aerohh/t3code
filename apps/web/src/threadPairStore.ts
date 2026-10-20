import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { openCommandPalette } from "./commandPaletteBus";
import { resolveStorage } from "./lib/storage";
import { readProject, readThreadShell } from "./state/entities";

export const THREAD_PAIR_MIN_CHAT_WIDTH = 480;
const THREAD_PAIR_DIVIDER_WIDTH = 1;
export const THREAD_PAIR_MIN_TOTAL_WIDTH =
  THREAD_PAIR_MIN_CHAT_WIDTH * 2 + THREAD_PAIR_DIVIDER_WIDTH;

export interface ThreadPair {
  readonly left: ScopedThreadRef;
  readonly right: ScopedThreadRef;
}

type PairableThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "archivedAt" | "deletedAt"
>;

const isOpenThread = (thread: PairableThread) =>
  thread.archivedAt === null && thread.deletedAt === null;

const sameThread = (a: ScopedThreadRef, b: ScopedThreadRef) =>
  scopedThreadKey(a) === scopedThreadKey(b);

const pairIncludes = (pair: ThreadPair, threadRef: ScopedThreadRef) =>
  sameThread(pair.left, threadRef) || sameThread(pair.right, threadRef);

const threadRefOf = (thread: PairableThread): ScopedThreadRef => ({
  environmentId: thread.environmentId,
  threadId: thread.id,
});

export function findThreadPair(
  pairs: ReadonlyArray<ThreadPair>,
  threadRef: ScopedThreadRef,
): ThreadPair | null {
  return pairs.find((pair) => pairIncludes(pair, threadRef)) ?? null;
}

/** The other chat in this chat's pair, which is on screen whenever this chat is. */
export function useThreadPairPartner(threadRef: ScopedThreadRef | null): ScopedThreadRef | null {
  return useThreadPairStore((state) => {
    if (threadRef === null) return null;
    const pair = findThreadPair(state.pairs, threadRef);
    if (pair === null) return null;
    return sameThread(pair.left, threadRef) ? pair.right : pair.left;
  });
}

/** A short reason shown beside a greyed-out "Open beside", or null when the two chats can pair. */
export function whyThreadsCannotPair(
  pairs: ReadonlyArray<ThreadPair>,
  current: PairableThread,
  other: PairableThread,
): string | null {
  if (current.environmentId === other.environmentId && current.id === other.id) {
    return "same chat";
  }
  if (current.environmentId !== other.environmentId || current.projectId !== other.projectId) {
    return "different project";
  }
  if (!isOpenThread(current) || !isOpenThread(other)) return "archived";
  if (findThreadPair(pairs, threadRefOf(current)) !== null) return "current chat already paired";
  if (findThreadPair(pairs, threadRefOf(other)) !== null) return "already paired";
  return null;
}

export function canPairThreads(
  pairs: ReadonlyArray<ThreadPair>,
  left: PairableThread,
  right: PairableThread,
): boolean {
  return whyThreadsCannotPair(pairs, left, right) === null;
}

/**
 * What a chat's menu offers: close its pair, pair it with the current chat, or pick a partner
 * for it when it is the current chat. Null hides the option.
 */
export type SideBySideMenuOption =
  | { readonly kind: "close" }
  | { readonly kind: "pick"; readonly blockedReason: string | null }
  | { readonly kind: "pair"; readonly blockedReason: string | null };

export function resolveSideBySideMenuOption(input: {
  readonly pairs: ReadonlyArray<ThreadPair>;
  readonly thread: PairableThread;
  readonly currentThread: PairableThread | null;
  readonly inScratchProject: boolean;
  readonly fitsOnScreen: boolean;
}): SideBySideMenuOption | null {
  const { pairs, thread, currentThread } = input;
  if (findThreadPair(pairs, threadRefOf(thread)) !== null) return { kind: "close" };
  if (currentThread === null || input.inScratchProject) return null;
  const roomReason = input.fitsOnScreen ? null : "not enough room";
  if (sameThread(threadRefOf(currentThread), threadRefOf(thread))) {
    return { kind: "pick", blockedReason: roomReason };
  }
  return {
    kind: "pair",
    blockedReason: whyThreadsCannotPair(pairs, currentThread, thread) ?? roomReason,
  };
}

/** Whether two chats fit once the desktop window has grown as far as the screen allows. */
export function threadPairFitsOnScreen(): boolean {
  const chatArea = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');
  const besideChats = chatArea ? window.innerWidth - chatArea.getBoundingClientRect().width : 0;
  const widestContent = window.desktopBridge?.setWindowMinimumContentWidth
    ? window.screen.availWidth - (window.outerWidth - window.innerWidth)
    : window.innerWidth;
  return widestContent - besideChats >= THREAD_PAIR_MIN_TOTAL_WIDTH;
}

export function readSideBySideMenuOption(
  threadRef: ScopedThreadRef,
  currentThreadRef: ScopedThreadRef | null,
): SideBySideMenuOption | null {
  const thread = readThreadShell(threadRef);
  if (thread === null) return null;
  return resolveSideBySideMenuOption({
    pairs: useThreadPairStore.getState().pairs,
    thread,
    currentThread: currentThreadRef ? readThreadShell(currentThreadRef) : null,
    inScratchProject:
      readProject(scopeProjectRef(thread.environmentId, thread.projectId))?.isScratch === true,
    fitsOnScreen: threadPairFitsOnScreen(),
  });
}

export function runSideBySideMenuOption(
  option: SideBySideMenuOption,
  threadRef: ScopedThreadRef,
  currentThreadRef: ScopedThreadRef | null,
): void {
  if (option.kind === "close") {
    useThreadPairStore.getState().closePair(threadRef);
    return;
  }
  if (option.blockedReason !== null) return;
  if (option.kind === "pick") {
    openCommandPalette({ open: "open-beside" });
    return;
  }
  if (currentThreadRef !== null)
    useThreadPairStore.getState().openPair(currentThreadRef, threadRef);
}

/** `null` means the thread is confirmed gone, not merely still loading. */
export function isThreadPairStillValid(
  left: PairableThread | null,
  right: PairableThread | null,
): boolean {
  if (left === null || right === null) return false;
  return (
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    isOpenThread(left) &&
    isOpenThread(right)
  );
}

interface ThreadPairStoreState {
  pairs: ThreadPair[];
  openPair: (left: ScopedThreadRef, right: ScopedThreadRef) => void;
  closePair: (threadRef: ScopedThreadRef) => void;
}

const isThreadRef = Schema.is(ScopedThreadRef);
const isThreadPair = (value: unknown): value is ThreadPair => {
  const pair = value as ThreadPair | null;
  return pair !== null && isThreadRef(pair.left) && isThreadRef(pair.right);
};

export const useThreadPairStore = create<ThreadPairStoreState>()(
  persist(
    (set) => ({
      pairs: [],
      openPair: (left, right) =>
        set((state) => ({
          pairs: [
            ...state.pairs.filter(
              (pair) => !pairIncludes(pair, left) && !pairIncludes(pair, right),
            ),
            { left, right },
          ],
        })),
      closePair: (threadRef) =>
        set((state) => {
          const pairs = state.pairs.filter((pair) => !pairIncludes(pair, threadRef));
          return pairs.length === state.pairs.length ? state : { pairs };
        }),
    }),
    {
      name: "t3code:thread-pairs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      // Validated on every load: a malformed pair would crash every chat screen that looks it up.
      merge: (persisted, current) => {
        const pairs = (persisted as Partial<Pick<ThreadPairStoreState, "pairs">> | null)?.pairs;
        return { ...current, pairs: Array.isArray(pairs) ? pairs.filter(isThreadPair) : [] };
      },
      partialize: ({ pairs }) => ({ pairs }),
    },
  ),
);
