import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ChevronRightIcon } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarListMarker,
} from "../Sidebar.logic";
import { SIDEBAR_SORTABLE_DRAG_DISABLED, sidebarTagBoxSurfaceClassName } from "./SidebarThreadRow";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";

function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

export function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

/** Keeps a Done or In progress marker in the list when its one chat has no box. */
export function SidebarEmptyShelfHeader(props: { marker: "done-header" | "working-header" }) {
  return <SortableSidebarMarker marker={props.marker} className="h-0" />;
}

export function SidebarDayLabel(props: {
  marker: "today-header" | "older-header";
  label: string;
  /** Sits under a box, so it overlaps the box's mb-3 instead of adding to it. */
  pullsUp: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      className={cn(
        "pointer-events-none mx-0.5 flex h-12 items-end px-2 pb-0.5 text-xs font-medium text-sidebar-muted-foreground/60",
        props.pullsUp && "-mt-3",
      )}
    >
      {props.label}
    </SortableSidebarMarker>
  );
}

export function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarSectionHeader(props: {
  marker: "snoozed-header" | "settled-header";
  label: string;
  /** A muted trailing count. */
  count: number;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
  /** The first shelf at the bottom of the list hosts the undo notice just above itself. */
  hostsUndoNotice?: boolean;
}) {
  const shelf = props.marker === "snoozed-header" ? "snoozed" : "settled";
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn("relative mx-0.5 h-8", props.className)}
    >
      {props.hostsUndoNotice ? (
        <SidebarThreadUndoNotice className="absolute inset-x-0 bottom-full bg-sidebar surface-grain" />
      ) : null}
      <CollapsibleSectionHeader
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}

// Box headers and "Show more" rows shift with the list during a drag like
// the section markers, but resolveSidebarDropTarget never accepts them.
export function SortableSidebarTagBoxItem(props: {
  id: string;
  className: string;
  children: ReactNode;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: props.id,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

export function SidebarTagBoxHeader(props: {
  id: string;
  displayName: string;
  /** The Done and In progress shelves reuse the box with a coloured top. */
  tone?: "info" | "success";
  threadCount: number;
  /** This tag's chats shown up in Done or In progress instead. */
  liftedCount: number;
  open: boolean;
  /** A box with no rows below its header ends here. */
  endsBox: boolean;
  /** Only closed active boxes report; null hides the line. Dot colors match
      the rows' own working and approval labels. */
  summary: { readonly workingCount: number; readonly needsYouCount: number } | null;
  onToggle: () => void;
}) {
  const summary =
    props.summary !== null && props.summary.workingCount + props.summary.needsYouCount > 0
      ? props.summary
      : null;
  return (
    <SortableSidebarTagBoxItem id={props.id} className={cn("mx-0.5 pt-1", props.endsBox && "mb-3")}>
      <div
        className={cn(
          "border-x border-t p-1",
          sidebarTagBoxSurfaceClassName(props.endsBox ? "whole" : "top"),
          props.endsBox ? "rounded-lg border-b" : "rounded-t-lg",
          // The tint covers the box's whole top slice, fading from its top
          // edge into the card, on a slightly blurred layer so it stays soft.
          "relative isolate overflow-hidden before:absolute before:inset-0 before:-z-10 before:bg-linear-to-b before:to-transparent before:blur-xs",
          props.tone === undefined && "before:from-sidebar-foreground/3.5",
          props.tone === "info" && "before:from-info/3.5",
          props.tone === "success" && "before:from-success/3",
        )}
      >
        <button
          type="button"
          aria-expanded={props.open}
          onClick={props.onToggle}
          className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs font-semibold text-sidebar-foreground hover:bg-sidebar-foreground/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
              props.open && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 truncate">{props.displayName}</span>
          <span className="shrink-0 rounded-full bg-sidebar-foreground/8 px-1.5 text-2xs font-medium leading-4 tabular-nums text-sidebar-muted-foreground">
            {props.threadCount}
          </span>
          {props.liftedCount > 0 ? (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-2xs font-medium leading-4 tabular-nums text-primary">
              <span className="sr-only">{`${props.liftedCount} in Done or In progress`}</span>
              <span aria-hidden>{props.liftedCount}</span>
            </span>
          ) : null}
        </button>
        {summary ? (
          <div className="flex items-center gap-1.5 pt-1 pb-0.5 ps-6.5 pe-2 text-2xs text-sidebar-muted-foreground">
            {summary.workingCount > 0 ? (
              <span className="flex items-center gap-1">
                <span aria-hidden className="size-1.5 rounded-full bg-info" />
                {summary.workingCount} working
              </span>
            ) : null}
            {summary.workingCount > 0 && summary.needsYouCount > 0 ? (
              <span aria-hidden>·</span>
            ) : null}
            {summary.needsYouCount > 0 ? (
              <span className="flex items-center gap-1">
                <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                {summary.needsYouCount} needs you
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </SortableSidebarTagBoxItem>
  );
}
