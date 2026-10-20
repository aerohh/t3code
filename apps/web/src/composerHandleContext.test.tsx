// @vitest-environment jsdom

import { act, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { ChatComposerHandle } from "./components/chat/ChatComposer";
import {
  ActiveComposerSlotContext,
  createActiveComposerSlot,
  type ActiveComposerSlot,
  useRegisterActiveComposer,
} from "./composerHandleContext";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Chat(props: { readonly prompt: string }) {
  const composerRef = useRef<ChatComposerHandle | null>(null);
  useRegisterActiveComposer(composerRef, true);
  useImperativeHandle(
    composerRef,
    () => ({ getSendContext: () => ({ prompt: props.prompt }) }) as unknown as ChatComposerHandle,
  );
  return null;
}

function activePrompt(slot: ActiveComposerSlot) {
  return slot.getComposer()?.getSendContext().prompt ?? null;
}

describe("active composer slot", () => {
  it("keeps the remaining chat when the other chat closes", () => {
    const slot = createActiveComposerSlot();
    const render = (chats: ReadonlyArray<string>) =>
      act(() =>
        root.render(
          <ActiveComposerSlotContext value={slot}>
            {chats.map((prompt) => (
              <Chat key={prompt} prompt={prompt} />
            ))}
          </ActiveComposerSlotContext>,
        ),
      );

    render(["left draft", "right draft"]);
    expect(activePrompt(slot)).toBe("right draft");

    render(["right draft"]);
    expect(activePrompt(slot)).toBe("right draft");

    render([]);
    expect(activePrompt(slot)).toBeNull();
  });
});
