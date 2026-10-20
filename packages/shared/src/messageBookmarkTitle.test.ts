import { describe, expect, it } from "vite-plus/test";
import { messageBookmarkTitle } from "./messageBookmarkTitle.ts";

describe("messageBookmarkTitle", () => {
  it("uses eight readable words and removes markup", () => {
    expect(messageBookmarkTitle("# **One** two\nthree four five six seven eight nine")).toBe(
      "One two three four five six seven eight",
    );
  });
  it("handles empty messages, attachments, and long words", () => {
    expect(messageBookmarkTitle("", "diagram.png")).toBe("diagram.png");
    expect(messageBookmarkTitle("   ")).toBe("Bookmarked message");
    expect(messageBookmarkTitle("a".repeat(300))).toHaveLength(160);
  });
});
