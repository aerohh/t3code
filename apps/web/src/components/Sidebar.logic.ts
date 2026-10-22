import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import * as React from "react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import {
  threadSearchMatchKey,
  threadSearchSubject,
  type ThreadSearchShell,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ContextMenuItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isSideChatThread } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { AsyncResult } from "effect/reactivity";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { normalizeSearchText } from "../lib/utils";
import { isLatestRunSettled } from "../session-logic";
import { observeIntersection } from "../lib/observeIntersection";
import { deadlineAfter, deadlineStore } from "@t3tools/client-runtime/clock";
import { useDeadlinePassed } from "../hooks/useDeadline";

export function shouldNavigateAfterThreadPark(input: {
  readonly threadKey: string;
  readonly currentThreadKey: string | null;
  readonly action: "settle" | "snooze";
  readonly now: string;
  readonly thread: (ThreadSnoozeShell & Pick<SidebarThreadSummary, "settledOverride">) | null;
}): boolean {
  return (
    input.threadKey === input.currentThreadKey &&
    input.thread !== null &&
    (input.action === "settle"
      ? input.thread.settledOverride === "settled"
      : effectiveSnoozed(input.thread, { now: input.now }))
  );
}

const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// Each prewarm retains growing thread detail and a live subscription, multiplying heap and server load.
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
const SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX = 160;

export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: (row: HTMLElement | null) => (() => void) | undefined;
} {
  const [isNearViewport, setIsNearViewport] = React.useState(isActive);
  if (isActive && !isNearViewport) setIsNearViewport(true);
  const canObserve = typeof IntersectionObserver !== "undefined";

  return {
    leaseLiveStatus: isActive || isNearViewport || !canObserve,
    rowRef: (row) => {
      if (row === null || isActive || !canObserve) return undefined;
      // The overscan has to apply to the sidebar's own scroller; a viewport-rooted
      // margin is still clipped by it.
      return observeIntersection(row, (entry) => setIsNearViewport(entry.isIntersecting), {
        root: row.closest('[data-slot="scroll-area-viewport"]'),
        rootMargin: `${SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX}px 0px`,
      });
    },
  };
}

const fileDragClears = new Set<(active: false) => void>();
function clearFileDrags() {
  const clears = [...fileDragClears];
  fileDragClears.clear();
  for (const clear of clears) clear(false);
}

/**
 * A file drag that ends outside every drop target (Escape, or a drop elsewhere)
 * sends no dragleave to the row it last entered, so the window's dragend clears it.
 */
export function setFileDragActive(setActive: (active: boolean) => void, active: boolean) {
  setActive(active);
  if (typeof window === "undefined") return;
  if (!active) {
    if (fileDragClears.delete(setActive) && fileDragClears.size === 0) {
      window.removeEventListener("dragend", clearFileDrags);
    }
    return;
  }
  if (fileDragClears.size === 0) window.addEventListener("dragend", clearFileDrags, { once: true });
  fileDragClears.add(setActive);
}

/**
 * A clock that advances exactly when a snooze wake time passes, so a woken
 * thread leaves the shelf on time without a per-second clock.
 */
export function useSnoozeWakeClock(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null | undefined }>,
): number {
  const [clockMs, setClockMs] = React.useState(() => Date.now());
  const wakeTimes: number[] = [];
  let nextWakeAt: number | null = null;
  for (const thread of threads) {
    const wakeAt = thread.snoozedUntil == null ? Number.NaN : Date.parse(thread.snoozedUntil);
    if (!(wakeAt > clockMs)) continue;
    wakeTimes.push(wakeAt);
    if (nextWakeAt === null || wakeAt < nextWakeAt) nextWakeAt = wakeAt;
  }
  const woke = useDeadlinePassed(nextWakeAt);
  // Advancing to the latest wake that has passed skips every wake that elapsed
  // meanwhile, e.g. across a laptop sleep. Stepping one wake at a time would
  // re-render once per elapsed wake and hit React's limit.
  if (woke && nextWakeAt !== null) {
    let nextClockMs = nextWakeAt;
    for (const wakeAt of wakeTimes) {
      if (wakeAt > nextClockMs && deadlineStore(wakeAt).getSnapshot()) nextClockMs = wakeAt;
    }
    setClockMs(nextClockMs);
    return nextClockMs;
  }
  return clockMs;
}

export function useRetainedValue<T>(key: string | null, value: T | null): T | null {
  const [retained, setRetained] = React.useState<{
    readonly key: string;
    readonly value: T;
  } | null>(null);
  if (key !== null && value !== null && (retained?.key !== key || retained.value !== value)) {
    setRetained({ key, value });
  }
  if (value !== null) return value;
  return key !== null && retained?.key === key ? retained.value : null;
}

// Sortable owns drag transforms; replaying committed order would animate drops twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

// Snoozed rows can leave the shelf, but dropping into it is not supported
// because snoozing requires a wake time. The Done and In progress shelves
// (beta) follow live status, so their rows only drag out as chat context,
// never between sidebar sections.

export type SidebarSection = "pinned" | "done" | "working" | "active" | "snoozed" | "settled";

export function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection {
  if (input.snoozed) return "snoozed";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  | "pinned-header"
  | "active-placeholder"
  | "settled-placeholder"
  | "pinned-divider"
  | "done-header"
  | "working-header"
  | "snoozed-header"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

export type SidebarTagBoxSection = "active" | "settled";

export type SidebarListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker }
  /** Tag boxes sit in the sortable list only so they shift with the rows
      during a drag. Nothing is lifted out of a box or dropped into one:
      resolveSidebarDropTarget rejects them as targets. */
  | {
      readonly kind: "tag-box-header";
      readonly section: SidebarTagBoxSection;
      readonly tagKey: string;
    }
  | {
      readonly kind: "tag-box-thread";
      readonly key: string;
      readonly section: SidebarTagBoxSection;
      readonly tagKey: string;
    }
  /** "Show more" at the bottom of an open settled box. */
  | { readonly kind: "tag-box-more"; readonly tagKey: string };

const SIDEBAR_TAG_BOX_PREFIX = "sidebar-tag-box-";

/** Tag names may contain colons, which only thread keys may. Escaping "%"
    first keeps the encoding one-to-one, and unlike encodeURIComponent it
    cannot throw on an odd string. */
function encodeTagKeyForSidebarId(tagKey: string): string {
  return tagKey.replaceAll("%", "%25").replaceAll(":", "%3A");
}

export function sidebarListItemId(item: SidebarListItem): string {
  switch (item.kind) {
    case "thread":
    case "tag-box-thread":
      return item.key;
    case "marker":
      return sidebarMarkerId(item.marker);
    case "tag-box-header":
      return `${SIDEBAR_TAG_BOX_PREFIX}${item.section}-${encodeTagKeyForSidebarId(item.tagKey)}`;
    case "tag-box-more":
      return `${SIDEBAR_TAG_BOX_PREFIX}more-${encodeTagKeyForSidebarId(item.tagKey)}`;
  }
}

function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "done-header") section = "done";
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

export type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== "thread") return null;
  const overKind = items[overIndex]?.kind;
  if (overKind !== "thread" && overKind !== "marker") return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  const section = sectionAtSidebarSlot(moved, overIndex);
  if (section === "done" || section === "working" || section === "snoozed") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider") currentSection = "active";
      else if (item.marker === "done-header") currentSection = "done";
      else if (item.marker === "working-header") currentSection = "working";
      else if (item.marker === "snoozed-header" || item.marker === "settled-header") break;
    } else if (item.kind !== "thread") {
      // Boxed rows keep their own order; the loose list is arranged without them.
      continue;
    } else if (currentSection === "pinned") pinnedOrder.push(item.key);
    else if (currentSection === "active") activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

export type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "move-active";
      readonly order: readonly string[] | null;
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null,
): SidebarDropVerb | null {
  if (to === null || to === from || to === "done" || to === "working" || to === "snoozed") {
    return null;
  }
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

export function resolveSidebarSweepKeys(
  orderedKeys: readonly string[],
  originKey: string,
  targetKey: string,
  canApply: (key: string) => boolean,
): string[] {
  const origin = orderedKeys.indexOf(originKey);
  const target = orderedKeys.indexOf(targetKey);
  if (origin === -1 || target === -1) return [];
  return orderedKeys.slice(Math.min(origin, target), Math.max(origin, target) + 1).filter(canApply);
}

export function sidebarThreadKeyAtY(list: HTMLElement, y: number): string | null {
  const viewport = list.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
  const visibleY = viewport ? Math.min(Math.max(y, viewport.top), viewport.bottom - 1) : y;
  let key: string | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("li[data-thread-item]")) {
    if (key !== null && row.getBoundingClientRect().top > visibleY) break;
    key = row.dataset.threadItem ?? null;
  }
  return key;
}

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
  readonly activeTimeOrdered?: boolean;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  if (activeSection === "done" || activeSection === "working") return { kind: "none" };
  if (input.supportsSettlement === false && (target.section === "settled" || activeSettled)) {
    return { kind: "none" };
  }
  const arrange = (
    order: readonly string[],
    keysById: ReadonlyMap<string, string | null | undefined>,
    writable: ReadonlySet<string> | undefined,
  ) => {
    if (!writable) return planPinnedReorder({ orderedIds: order, keysById, movedId: activeKey });
    if (!writable.has(activeKey)) return null;
    const assignments = planPinnedReorder({
      orderedIds: order.filter((key) => writable.has(key) || keysById.get(key) != null),
      keysById,
      movedId: activeKey,
    });
    return assignments.every(({ id }) => writable.has(id)) ? assignments : null;
  };
  switch (target.section) {
    case "active": {
      if (input.activeTimeOrdered) {
        return activeSection === "active"
          ? { kind: "none" }
          : {
              kind: "move-active",
              order: null,
              assignments: [],
              unpin: activePinned,
              unsettle: activeSettled,
              unsnooze: activeSection === "snoozed",
            };
      }
      const order = target.activeOrder;
      if (
        activeSection === "active" &&
        order.length === activeOrder.length &&
        order.every((key, index) => key === activeOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, activeKeysById, activeReorderableKeys);
      if (assignments === null) return { kind: "none" };
      return {
        kind: "move-active",
        order,
        assignments,
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
      };
    }
    case "settled":
      return activeSection === "settled" ? { kind: "none" } : { kind: "settle" };
    case "pinned": {
      const order = target.pinnedOrder;
      if (
        activeSection === "pinned" &&
        order.length === pinnedOrder.length &&
        order.every((key, index) => key === pinnedOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, pinnedKeysById, reorderableKeys);
      if (assignments === null) return { kind: "none" };
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

export function applySidebarThreadDrop<
  T extends Pick<
    SidebarThreadSummary,
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "snoozedAt"
    | "snoozedUntil"
    | "settledAt"
    | "settledOverride"
    | "unsettledAt"
  >,
>(thread: T, section: "pinned" | "active" | "settled", now: string, orderKey?: string): T {
  const wasSettled = thread.settledOverride === "settled";
  const awake = { ...thread, snoozedAt: null, snoozedUntil: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledOverride: "settled",
      settledAt: wasSettled ? (thread.settledAt ?? now) : now,
      unsettledAt: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : awake;
  return {
    ...resumed,
    pinnedAt: section === "pinned" ? (thread.pinnedAt ?? now) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...(section === "active" && orderKey !== undefined ? { activeOrderKey: orderKey } : {}),
  };
}

type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

export type ThreadTraversalDirection = "previous" | "next";

/** Exclude only successful deletions from shared-worktree checks. */
export async function deleteSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  delete: (
    entry: TEntry,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
}) {
  const deletedThreadKeys = new Set<string>();
  let firstFailure: AsyncResult.Failure<unknown, unknown> | null = null;

  for (const entry of input.entries) {
    const result = await input.delete(entry, deletedThreadKeys);
    if (result === null) continue;
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      firstFailure ??= result;
      continue;
    }
    deletedThreadKeys.add(entry.threadKey);
  }

  return { deletedThreadKeys, firstFailure };
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function isSidebarSubagentThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

// Subagent threads have no sidebar row, so an open subagent is represented by
// its nearest non-subagent ancestor. A broken chain (missing parent, cycle,
// other environment) resolves to the thread itself, which then matches no row.
export function resolveSidebarRowThreadId(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  threads: readonly Pick<SidebarThreadSummary, "id" | "environmentId" | "lineage">[],
): ThreadId {
  const findThread = (id: ThreadId) =>
    threads.find((thread) => thread.id === id && thread.environmentId === environmentId);
  const visited = new Set<ThreadId>();
  let thread = findThread(threadId);
  while (thread !== undefined && isSidebarSubagentThread(thread)) {
    if (thread.lineage.parentThreadId === null || visited.has(thread.id)) return threadId;
    visited.add(thread.id);
    thread = findThread(thread.lineage.parentThreadId);
  }
  return thread?.id ?? threadId;
}

/**
 * `delegatedUnderParent` holds the tasks linked environments run for a thread
 * the sidebar lists, by thread key; they show under that thread, as subagents do.
 */
export function filterSidebarV2VisibleThreads<
  T extends Pick<
    SidebarThreadSummary,
    "archivedAt" | "environmentId" | "id" | "lineage" | "sideChat"
  > & {
    projectId: string;
  },
>(
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  delegatedUnderParent: ReadonlySet<string>,
): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !isShownUnderParent(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.lineage,
        delegatedUnderParent,
      ) &&
      !isSideChatThread(thread) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
}

/**
 * Tag names are case-insensitive: "Billing" and "billing" are one tag. Every
 * place that compares or groups tags goes through this key. Plain toLowerCase,
 * not the locale variant, so every client groups the same names together.
 */
export function threadTagGroupKey(tagName: string): string {
  return tagName.toLowerCase();
}

/**
 * Every distinct tag on the chats the sidebar shows, across all environments
 * and projects, sorted alphabetically ignoring case. When chats spell one tag
 * differently, the spelling most chats use wins; a tie goes to the spelling
 * that sorts first, so the label never flips between renders.
 */
export function collectSidebarThreadTagNames<
  T extends Pick<
    SidebarThreadSummary,
    "archivedAt" | "environmentId" | "id" | "lineage" | "sideChat" | "tag" | "deletedAt"
  > & {
    projectId: string;
  },
>(threads: readonly T[]): string[] {
  const spellingCountsByKey = new Map<string, Map<string, number>>();
  // Nesting a delegated task under its parent doesn't make its tag any less a name to offer.
  for (const thread of filterSidebarV2VisibleThreads(threads, null, new Set())) {
    if (thread.tag === null || thread.deletedAt !== null) continue;
    const key = threadTagGroupKey(thread.tag);
    const spellingCounts = spellingCountsByKey.get(key) ?? new Map<string, number>();
    spellingCounts.set(thread.tag, (spellingCounts.get(thread.tag) ?? 0) + 1);
    spellingCountsByKey.set(key, spellingCounts);
  }
  const displayNames: string[] = [];
  for (const spellingCounts of spellingCountsByKey.values()) {
    let displayName: string | null = null;
    let displayCount = 0;
    for (const [spelling, count] of spellingCounts) {
      const winsTie = count === displayCount && displayName !== null && spelling < displayName;
      if (count > displayCount || winsTie) {
        displayName = spelling;
        displayCount = count;
      }
    }
    if (displayName !== null) displayNames.push(displayName);
  }
  return displayNames.sort(
    (left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }) ||
      (threadTagGroupKey(left) < threadTagGroupKey(right) ? -1 : 1),
  );
}

/**
 * The name to save for what the user typed: trimmed, and the existing tag's
 * spelling when it matches one ignoring case, so typing "billing" joins
 * "Billing" instead of starting a second tag. Null when nothing was typed.
 */
export function resolveThreadTagNameForSave(
  typedName: string,
  existingTagNames: readonly string[],
): string | null {
  const trimmedName = typedName.trim();
  if (trimmedName === "") return null;
  const typedKey = threadTagGroupKey(trimmedName);
  return existingTagNames.find((name) => threadTagGroupKey(name) === typedKey) ?? trimmedName;
}

/** One tag's chats from a single sidebar list, drawn as a folder box. */
export interface SidebarTagBox<T> {
  readonly tagKey: string;
  readonly displayName: string;
  readonly threads: readonly T[];
}

const SIDEBAR_TAG_BOX_MIN_THREADS = 2;

/** Done and In progress follow the folders' rule: one chat is a plain row, not a box. */
export function isSidebarShelfBoxed(threads: readonly unknown[]): boolean {
  return threads.length >= SIDEBAR_TAG_BOX_MIN_THREADS;
}

/**
 * Splits a sorted list into one box per tag plus the untagged rest. Boxes follow the
 * alphabetical `tagDisplayNames`, so a box never moves when a chat gets busy. A tag gets a
 * box only with two or more chats, counting those lifted into Done and In progress.
 */
export function groupSidebarThreadsByTag<T extends Pick<SidebarThreadSummary, "tag">>(
  threads: readonly T[],
  tagDisplayNames: readonly string[],
  liftedCountByTagKey: ReadonlyMap<string, number> = new Map(),
): { readonly boxes: SidebarTagBox<T>[]; readonly looseThreads: T[] } {
  const listedCountByTagKey = new Map<string, number>();
  for (const thread of threads) {
    if (thread.tag === null) continue;
    const tagKey = threadTagGroupKey(thread.tag);
    listedCountByTagKey.set(tagKey, (listedCountByTagKey.get(tagKey) ?? 0) + 1);
  }
  const looseThreads: T[] = [];
  const threadsByTagKey = new Map<string, { readonly spelling: string; readonly threads: T[] }>();
  for (const thread of threads) {
    if (thread.tag === null) {
      looseThreads.push(thread);
      continue;
    }
    const tagKey = threadTagGroupKey(thread.tag);
    const totalCount =
      (listedCountByTagKey.get(tagKey) ?? 0) + (liftedCountByTagKey.get(tagKey) ?? 0);
    if (totalCount < SIDEBAR_TAG_BOX_MIN_THREADS) {
      looseThreads.push(thread);
      continue;
    }
    const group = threadsByTagKey.get(tagKey);
    if (group) group.threads.push(thread);
    else threadsByTagKey.set(tagKey, { spelling: thread.tag, threads: [thread] });
  }
  const rankByTagKey = new Map(
    tagDisplayNames.map((name, index) => [threadTagGroupKey(name), { name, index }] as const),
  );
  const boxes = Array.from(threadsByTagKey, ([tagKey, group]) => ({
    tagKey,
    displayName: rankByTagKey.get(tagKey)?.name ?? group.spelling,
    threads: group.threads,
  }));
  boxes.sort(
    (left, right) =>
      (rankByTagKey.get(left.tagKey)?.index ?? Number.POSITIVE_INFINITY) -
        (rankByTagKey.get(right.tagKey)?.index ?? Number.POSITIVE_INFINITY) ||
      (left.tagKey < right.tagKey ? -1 : left.tagKey > right.tagKey ? 1 : 0),
  );
  return { boxes, looseThreads };
}

/** What a closed box reports about its chats, using the same status each row shows. */
export function summarizeSidebarTagBoxStatus(threads: readonly SidebarThreadStatusInput[]): {
  readonly workingCount: number;
  readonly needsYouCount: number;
} {
  let workingCount = 0;
  let needsYouCount = 0;
  for (const thread of threads) {
    const status = resolveSidebarThreadStatus(thread);
    if (status === "working") workingCount += 1;
    else if (status === "approval" || status === "input") needsYouCount += 1;
  }
  return { workingCount, needsYouCount };
}

/** The boxes the user flipped from their default, by tag key. Active boxes
    start open, so only closed ones are stored; settled boxes start closed,
    so only open ones are. */
export interface SidebarTagBoxToggles {
  readonly closedActiveTagKeys: readonly string[];
  readonly openSettledTagKeys: readonly string[];
}

export function isSidebarTagBoxOpen(
  toggles: SidebarTagBoxToggles,
  section: SidebarTagBoxSection,
  tagKey: string,
): boolean {
  return section === "active"
    ? !toggles.closedActiveTagKeys.includes(tagKey)
    : toggles.openSettledTagKeys.includes(tagKey);
}

export function toggleSidebarTagBox(
  toggles: SidebarTagBoxToggles,
  section: SidebarTagBoxSection,
  tagKey: string,
): SidebarTagBoxToggles {
  const flip = (tagKeys: readonly string[]) =>
    tagKeys.includes(tagKey) ? tagKeys.filter((key) => key !== tagKey) : [...tagKeys, tagKey];
  return section === "active"
    ? { ...toggles, closedActiveTagKeys: flip(toggles.closedActiveTagKeys) }
    : { ...toggles, openSettledTagKeys: flip(toggles.openSettledTagKeys) };
}

/**
 * The rows a box renders. Open: the first `visibleCount` (settled boxes page
 * like the settled tail). Closed: none. Either way the open chat stays, so it
 * never hides inside a folder.
 */
export function resolveSidebarTagBoxRows<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(input: {
  readonly threads: readonly T[];
  readonly open: boolean;
  readonly visibleCount: number;
  readonly routeThreadKey: string | null;
}): { readonly rows: readonly T[]; readonly hiddenCount: number } {
  const isRouteThread = (thread: T) =>
    input.routeThreadKey !== null &&
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === input.routeThreadKey;
  if (!input.open) {
    const routeThread = input.threads.find(isRouteThread);
    return { rows: routeThread === undefined ? [] : [routeThread], hiddenCount: 0 };
  }
  const rows = input.threads.slice(0, input.visibleCount);
  const hiddenRouteThread = input.threads.slice(input.visibleCount).find(isRouteThread);
  if (hiddenRouteThread !== undefined) rows.push(hiddenRouteThread);
  return { rows, hiddenCount: input.threads.length - rows.length };
}

export function buildBulkTitleRegenerationContextMenuItem(input: {
  supportedCount: number;
  actionableCount: number;
}): ContextMenuItem<"regenerate-title"> | null {
  if (input.supportedCount === 0) return null;
  if (input.actionableCount === 0) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.supportedCount})`,
      disabled: true,
    };
  }
  return {
    id: "regenerate-title",
    label: `Regenerate titles (${input.actionableCount})`,
  };
}

export function buildBulkUnpinContextMenuItem(input: {
  pinnedCount: number;
}): ContextMenuItem<"unpin"> | null {
  if (input.pinnedCount === 0) return null;
  return { id: "unpin", label: `Unpin (${input.pinnedCount})` };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Failed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Guest Request"
    | "Waiting"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  "Guest Request": 3.75,
  Failed: 3.5,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
  blockedOnThreadWait?: boolean | undefined;
};

/**
 * Thread jump hints appear once the jump modifier has been held for a moment,
 * so a quick shortcut never flashes them, and hide as soon as it is released.
 */
export function useThreadJumpHintsVisible(shouldShow: boolean): boolean {
  const [showAt, setShowAt] = React.useState<number | null>(null);
  // The clock is read inside the updater: the compiler caches a bare clock read
  // in render once per instance, so a second hold would reuse the first deadline.
  // React discards this render and re-runs with the update.
  if (shouldShow !== (showAt !== null)) {
    setShowAt(shouldShow ? () => deadlineAfter(THREAD_JUMP_HINT_SHOW_DELAY_MS) : null);
  }
  return useDeadlinePassed(showAt);
}

export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // Server visits override local watermarks, including mark-unread rewinds; use local values only on older
  // servers.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Unopened threads' failures still count as unseen, unlike completions. */
function hasUnseenFailure(thread: ThreadStatusInput): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// Suppress trailing double-click navigation; keyboard and synthetic clicks use detail 0.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

export function isSidebarNestedLinkClick(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  if (nodeClosest(target, "a[href]") !== null) return true;
  const parent =
    "parentElement" in target &&
    target.parentElement !== null &&
    typeof target.parentElement === "object"
      ? target.parentElement
      : null;
  return nodeClosest(parent, "a[href]") !== null;
}

export function shouldCreateNewThreadInCurrentProject(
  shiftKey: boolean,
  projectGroupCount: number,
): boolean {
  return shiftKey || projectGroupCount <= 1;
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (
    input.isActive ||
    input.isSelected ||
    input.status === "input" ||
    input.status === "request"
  ) {
    return false;
  }
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

export type SidebarV2TopStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "request"
  | "waiting"
  | "woke"
  | "working";

export function resolveSidebarV2TopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): SidebarV2TopStatusKind | null {
  if (input.status === "working") {
    return "working";
  }
  if (input.status === "waiting") {
    return "waiting";
  }
  if (input.status === "approval") {
    return "approval";
  }
  if (input.status === "input" || input.status === "request") {
    return input.status;
  }
  if (input.status === "failed" || input.status === "limited") {
    return input.status;
  }
  if (input.isWoke) {
    return "woke";
  }
  return input.isUnread ? "done" : null;
}

/**
 * Pulls each project's threads together, keeping the list's order inside a
 * project and ordering projects by where their first thread sits. On a
 * newest-first list, the project with the newest thread leads.
 */
export function groupSidebarThreadsByProject<
  T extends Pick<SidebarThreadSummary, "environmentId" | "projectId">,
>(threads: readonly T[]): T[] {
  const threadsByProject = new Map<string, T[]>();
  for (const thread of threads) {
    const projectKey = `${thread.environmentId}:${thread.projectId}`;
    const projectThreads = threadsByProject.get(projectKey);
    if (projectThreads) projectThreads.push(thread);
    else threadsByProject.set(projectKey, [thread]);
  }
  return Array.from(threadsByProject.values()).flat();
}

export function isSidebarThreadWoke(input: {
  readonly wokeAt: string | null;
  readonly lastVisitedAt: string | undefined;
  readonly settledOverride: SidebarThreadSummary["settledOverride"];
}): boolean {
  if (input.wokeAt === null || input.settledOverride === "settled") return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAtMs)) return false;
  const lastVisitedAtMs =
    input.lastVisitedAt === undefined ? Number.NaN : Date.parse(input.lastVisitedAt);
  return Number.isNaN(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs;
}

/** True when the chat's row shows "Done", which is the rule the Done shelf uses. */
export function isSidebarThreadDone(
  thread: ThreadStatusInput &
    SidebarThreadStatusInput &
    Pick<SidebarThreadSummary, "settledOverride">,
  input: { readonly lastVisitedAt: string | undefined; readonly wokeAt: string | null },
): boolean {
  return (
    resolveSidebarV2TopStatus({
      status: resolveSidebarThreadStatus(thread),
      isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt: input.lastVisitedAt }),
      isWoke: isSidebarThreadWoke({
        wokeAt: input.wokeAt,
        lastVisitedAt: input.lastVisitedAt,
        settledOverride: thread.settledOverride,
      }),
    }) === "done"
  );
}

export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export { sortActiveThreadsByOrderKey as sortThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";
export {
  isThreadWorking as isSidebarThreadWorking,
  sortDoneThreadsByFinish,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";

export { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

const EMPTY_CONTENT_MATCH_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Sidebar search results: title, branch, and pull request matches ranked as
 * the command palette ranks them, then threads listed only because their
 * messages match, in `contentMatchKeys` order.
 */
export function searchSidebarThreads<
  T extends ThreadSearchShell & {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  },
>(
  threads: readonly T[],
  query: string,
  contentMatchKeys: ReadonlySet<string> = EMPTY_CONTENT_MATCH_KEYS,
  now = Date.now(),
): { readonly titleMatches: T[]; readonly contentMatches: T[] } {
  const normalizedQuery = foldSearchQuery(query);
  if (normalizedQuery.length === 0) return { titleMatches: [], contentMatches: [] };
  const titleMatches = rankSearchItems(threads, (thread, options) =>
    scoreThreadSearch(normalizedQuery, threadSearchSubject(thread, null), now, {
      ...options,
      picks: false,
    }),
  ).map(({ item }) => item);
  const listed = new Set(titleMatches);
  // In the order the server ranked their messages, as the palette lists them.
  const threadByKey = new Map(
    threads.map((thread) => [
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread,
    ]),
  );
  const contentMatches = [...contentMatchKeys].flatMap((key) => {
    const thread = threadByKey.get(key);
    return thread && !listed.has(thread) ? [thread] : [];
  });
  return { titleMatches, contentMatches };
}

export function pullRequestMatchesSearchQuery(
  pullRequest: Parameters<typeof threadPullRequestSearchTerms>[0],
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return false;
  const haystack = normalizeSearchText(threadPullRequestSearchTerms(pullRequest).join(" "));
  return normalizedQuery.split(" ").every((token) => haystack.includes(token));
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => item.value !== "all" && input.matches(item, query));
}

export interface SidebarProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}

export type SidebarProjectScopeMenuAction =
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "open-changed"; readonly open: boolean }
  | { readonly type: "project-settings-opened" };

export function reduceSidebarProjectScopeMenuState(
  state: SidebarProjectScopeMenuState,
  action: SidebarProjectScopeMenuAction,
): SidebarProjectScopeMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}

export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestRun" | "runtime">,
): string | null {
  return resolveThreadWorkingStartedAt(thread);
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return {
      label: "Guest Request",
      colorClass: "text-guest-foreground",
      dotClass: "bg-guest",
      pulse: false,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait !== true) ||
    thread.runtime?.status === "waiting"
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return {
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  if (hasUnseenFailure(thread)) {
    return {
      label: "Failed",
      colorClass: "text-red-600 dark:text-red-300/90",
      dotClass: "bg-red-500 dark:bg-red-300/90",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  // Project timestamps scan all threads; compute once per project instead of per comparison.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(project, getProjectThreads(project), sortOrder),
    }))
    .sort((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return byTimestamp || compareTies(left.project, right.project);
    })
    .map(({ project }) => project);
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

export function sortSidebarV2ProjectGroups<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread &
    Pick<SidebarThreadSummary, "environmentId" | "id" | "lineage">,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
  delegatedUnderParent: ReadonlySet<string>,
): TProject[] {
  return sortLogicalProjectsForSidebar(
    projects,
    filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent),
    sortOrder,
  );
}

export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
