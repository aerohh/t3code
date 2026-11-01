import { describe, expect, it } from "vite-plus/test";

import { sanitizeCommitSubject, sanitizeThreadSummary } from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("sanitizeThreadSummary", () => {
  it("fits an oversized note into the stored summary limits", () => {
    const summary = sanitizeThreadSummary({
      about: `  ${"a".repeat(700)}  `,
      verdict: "Fixed\n\nand   tested.",
      stillOpen: [
        "Check mobile",
        "Check mobile",
        "  ",
        ...Array.from({ length: 8 }, (_, i) => `Item ${i}`),
      ],
    });
    expect(summary.about).toHaveLength(600);
    expect(summary.about.endsWith("…")).toBe(true);
    expect(summary.verdict).toBe("Fixed and tested.");
    expect(summary.stillOpen).toEqual([
      "Check mobile",
      "Item 0",
      "Item 1",
      "Item 2",
      "Item 3",
      "Item 4",
    ]);
  });
});
