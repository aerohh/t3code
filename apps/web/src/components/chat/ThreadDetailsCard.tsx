import { use, useLayoutEffect, type MouseEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarMenuButton, useSidebarVisibility } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { useThreadPane } from "../../threadPaneContext";
import { useSidebarThreadDetailsSlots } from "../sidebar/SidebarChrome";
import { BackgroundThreadContext } from "./backgroundThread";
import { workspaceAreaProps } from "../../lib/workspaceFocus";

/**
 * The open chat's branch in the sidebar's bottom dock. Clicking it opens the chat's details
 * inside the dock, above the icons. Only the chat the user is working in fills the dock, and
 * nothing shows while the sidebar is closed.
 */
export function ThreadDetailsCard({
  threadRef,
  summary,
  hint,
  onContextMenu,
  children,
}: {
  threadRef: ScopedThreadRef;
  summary: ReactNode;
  hint: string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  const slots = useSidebarThreadDetailsSlots();
  const sidebarVisible = useSidebarVisibility();
  const backgroundThread = use(BackgroundThreadContext);
  const { isActivePane } = useThreadPane();
  const open = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef),
  );
  const shown =
    slots.button !== null &&
    slots.panel !== null &&
    sidebarVisible &&
    !backgroundThread &&
    isActivePane;
  // Hiding the sidebar removes the details without a toggle, so a flag left set would open
  // them again the next time the sidebar shows.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the details flag in the right panel store when the sidebar dock goes away
  useLayoutEffect(() => {
    if (!shown && open) useRightPanelStore.getState().setThreadPanelOpen(threadRef, false);
  }, [shown, open, threadRef]);

  if (!shown || slots.button === null || slots.panel === null) return null;
  return (
    <>
      {createPortal(
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  isActive={open}
                  aria-expanded={open}
                  className="w-auto min-w-0"
                  onClick={() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, !open)}
                />
              }
            >
              {summary}
            </TooltipTrigger>
            <TooltipPopup side="top">{hint}</TooltipPopup>
          </Tooltip>
        </>,
        slots.button,
      )}
      {open
        ? createPortal(
            <div
              {...workspaceAreaProps("details", 3, "Thread details")}
              data-workspace-focus-key={`details:${threadRef.environmentId}:${threadRef.threadId}`}
              className="grid max-h-[50dvh] grid-rows-[minmax(0,1fr)]"
              onContextMenu={onContextMenu}
              data-thread-details-card
            >
              <ScrollArea scrollFade className="min-h-0">
                {children}
              </ScrollArea>
            </div>,
            slots.panel,
          )
        : null}
    </>
  );
}
