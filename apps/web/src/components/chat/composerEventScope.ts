import { useActiveComposerSlot, useComposerHandleContext } from "../../composerHandleContext";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

export function useComposerMenuProps() {
  const chatComposerRef = useComposerHandleContext();
  const activeComposerSlot = useActiveComposerSlot();

  return {
    ...composerFloatingLayerProps,
    finalFocus:
      chatComposerRef || activeComposerSlot
        ? () => {
            const activeElement = document.activeElement;
            if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) {
              return false;
            }
            const composer = chatComposerRef
              ? chatComposerRef.current
              : activeComposerSlot?.getComposer();
            composer?.focusAtEnd();
            return false;
          }
        : undefined,
  };
}

function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  );
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest("[data-composer-context-control]") !== null ||
      isInsideComposerFloatingLayer(target))
  );
}
