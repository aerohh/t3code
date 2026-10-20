import { createContext, use } from "react";

export interface ThreadPane {
  /** Null when the chat fills the window on its own. */
  readonly side: "left" | "right" | null;
  /** Window-level shortcuts, paste and menu actions act only on the active pane. */
  readonly isActivePane: boolean;
  readonly closePair: () => void;
}

const SINGLE_PANE: ThreadPane = { side: null, isActivePane: true, closePair: () => {} };

export const ThreadPaneContext = createContext<ThreadPane>(SINGLE_PANE);

export function useThreadPane(): ThreadPane {
  return use(ThreadPaneContext);
}
