import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { splitReasoningChoices } from "./modelTraits.ts";

function effortDescriptor(
  ids: ReadonlyArray<string>,
  promptInjectedValues?: ReadonlyArray<string>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "effort",
    label: "Reasoning",
    type: "select",
    options: ids.map((id) => ({ id, label: id })),
    ...(promptInjectedValues ? { promptInjectedValues: [...promptInjectedValues] } : {}),
  };
}

const ids = (choices: ReadonlyArray<{ id: string }>) => choices.map((choice) => choice.id);

describe("splitReasoningChoices", () => {
  it("keeps Ultracode and Ultrathink off the level scale", () => {
    const split = splitReasoningChoices(
      effortDescriptor(
        ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
        ["ultrathink"],
      ),
    );
    expect(ids(split.levels)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(ids(split.modes)).toEqual(["ultracode", "ultrathink"]);
  });
});
