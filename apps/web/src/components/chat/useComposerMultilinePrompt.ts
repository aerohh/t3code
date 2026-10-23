import { useLayoutEffect, useRef, useState } from "react";
import { observeResize } from "../../lib/observeResize";

function measureComposerMultilinePrompt(body: HTMLElement): boolean | null {
  const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!editor || editor.clientWidth === 0) return null;

  const bodyStyle = getComputedStyle(body);
  const expandedWidth =
    body.clientWidth -
    Number.parseFloat(bodyStyle.paddingLeft) -
    Number.parseFloat(bodyStyle.paddingRight);
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  const range = document.createRange();
  range.selectNodeContents(editor);
  const bounds = range.getBoundingClientRect();

  // Measure against expanded width to prevent inline actions oscillating collapse.
  return bounds.height > lineHeight + 1 || bounds.width > expandedWidth + 1;
}

/** Whether the prompt wraps, and the ref callback that measures it on the composer body. */
export function useComposerMultilinePrompt(): readonly [
  boolean,
  (body: HTMLElement | null) => (() => void) | undefined,
] {
  const [isMultiline, setIsMultiline] = useState(false);
  const observeBody = (body: HTMLElement | null) => {
    if (!body) return;
    const measure = () => {
      const next = measureComposerMultilinePrompt(body);
      if (next !== null) setIsMultiline(next);
    };
    measure();
    const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    const stopObserving = observeResize(editor ? [body, editor] : body, measure);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(body, { childList: true, characterData: true, subtree: true });
    return () => {
      stopObserving();
      mutationObserver.disconnect();
    };
  };
  return [isMultiline, observeBody] as const;
}

function measureSlimComposerPromptNeedsOwnRow(
  body: HTMLElement,
  promptOnOwnRow: boolean,
): boolean | null {
  const surface = body.closest<HTMLElement>('[data-chat-composer-surface="true"]');
  const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  const attach = surface?.querySelector<HTMLElement>('[data-chat-composer-attach="true"]');
  const actions = surface?.querySelector<HTMLElement>('[data-chat-composer-actions="right"]');
  if (!surface || !editor || !attach || !actions || editor.clientWidth === 0) return null;

  // Span the text itself: a range over the whole editor includes its paragraph
  // boxes, which are always as wide as the editor.
  const textWalker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const firstText = textWalker.nextNode();
  if (!firstText) return false;
  let lastText = firstText;
  for (let text = textWalker.nextNode(); text; text = textWalker.nextNode()) lastText = text;
  const range = document.createRange();
  range.setStart(firstText, 0);
  range.setEnd(lastText, lastText.textContent?.length ?? 0);
  const bounds = range.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  if (bounds.height > lineHeight + 1) return true;

  const bodyStyle = getComputedStyle(body);
  const besideControlsWidth =
    surface.clientWidth -
    attach.offsetWidth -
    actions.offsetWidth -
    Number.parseFloat(bodyStyle.paddingLeft) -
    Number.parseFloat(bodyStyle.paddingRight);
  // On its own row the prompt has room to spare, so it only moves back beside
  // the controls once it clearly fits there; otherwise the two layouts would
  // keep handing the prompt back and forth.
  return bounds.width > besideControlsWidth - (promptOnOwnRow ? 4 : -1);
}

/** Whether the one-line bar should give a wrapping prompt its own row above the controls. */
export function useSlimComposerPromptOnOwnRow(body: HTMLElement | null, enabled: boolean): boolean {
  const [promptOnOwnRow, setPromptOnOwnRow] = useState(false);
  const promptOnOwnRowRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resize and mutation observers on the composer body while the one-line bar shows
  useLayoutEffect(() => {
    if (!body || !enabled) return;
    const measure = () => {
      const next = measureSlimComposerPromptNeedsOwnRow(body, promptOnOwnRowRef.current);
      if (next === null || next === promptOnOwnRowRef.current) return;
      promptOnOwnRowRef.current = next;
      setPromptOnOwnRow(next);
    };
    measure();
    const surface = body.closest<HTMLElement>('[data-chat-composer-surface="true"]');
    const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    const actions = surface?.querySelector<HTMLElement>('[data-chat-composer-actions="right"]');
    const stopObserving = observeResize(
      [body, editor, actions].filter((element) => element != null),
      measure,
    );
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(body, { childList: true, characterData: true, subtree: true });
    return () => {
      stopObserving();
      mutationObserver.disconnect();
    };
  }, [body, enabled]);

  return enabled && promptOnOwnRow;
}
