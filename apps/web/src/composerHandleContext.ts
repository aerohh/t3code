import { createContext, use, useEffect } from "react";
import type { ChatComposerHandle } from "./components/chat/ChatComposer";

export type ComposerHandleRef = React.RefObject<ChatComposerHandle | null>;

// Each ChatView provides its own composer, so two chats on screen never read each other's prompt.
export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null);

export function useComposerHandleContext(): ComposerHandleRef | null {
  return use(ComposerHandleContext);
}

// The command palette sits outside every ChatView and needs the composer of the chat in use.
export interface ActiveComposerSlot {
  readonly getComposer: () => ChatComposerHandle | null;
  readonly register: (composerRef: ComposerHandleRef) => () => void;
}

export function createActiveComposerSlot(): ActiveComposerSlot {
  let activeComposerRef: ComposerHandleRef | null = null;
  return {
    getComposer: () => activeComposerRef?.current ?? null,
    register: (composerRef) => {
      activeComposerRef = composerRef;
      return () => {
        if (activeComposerRef === composerRef) {
          activeComposerRef = null;
        }
      };
    },
  };
}

export const ActiveComposerSlotContext = createContext<ActiveComposerSlot | null>(null);

export function useActiveComposerSlot(): ActiveComposerSlot | null {
  return use(ActiveComposerSlotContext);
}

export function useRegisterActiveComposer(composerRef: ComposerHandleRef, isActive: boolean): void {
  const activeComposerSlot = use(ActiveComposerSlotContext);
  useEffect(
    () => (isActive ? activeComposerSlot?.register(composerRef) : undefined),
    [activeComposerSlot, composerRef, isActive],
  );
}
