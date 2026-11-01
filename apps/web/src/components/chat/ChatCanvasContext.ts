import { createContext, useContext } from "react";
import type { resolveChatCanvasLayout } from "./chatCanvasLayout";

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  previewKey: string | null;
  registerTimeline: (element: HTMLElement | null) => void;
  findBarTopInset: number;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
