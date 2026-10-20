import { describe, expect, it } from "vite-plus/test";

import type { ChatComposerHandle } from "./components/chat/ChatComposer";
import { type ComposerHandleRef, createActiveComposerSlot } from "./composerHandleContext";

function composerWithPrompt(prompt: string): ComposerHandleRef {
  return { current: { getSendContext: () => ({ prompt }) } as unknown as ChatComposerHandle };
}

describe("active composer slot", () => {
  it("keeps the remaining chat when the other chat closes", () => {
    const slot = createActiveComposerSlot();
    const unregisterLeft = slot.register(composerWithPrompt("left draft"));
    const unregisterRight = slot.register(composerWithPrompt("right draft"));

    unregisterLeft();
    expect(slot.getComposer()?.getSendContext().prompt).toBe("right draft");

    unregisterRight();
    expect(slot.getComposer()).toBeNull();
  });
});
