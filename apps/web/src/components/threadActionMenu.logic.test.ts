import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  currentTag: null,
  tagNames: [],
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
    tags: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
  sideBySide: null,
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "tag",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "tag",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("offers existing tags in order with the thread's tag checked, then New tag", () => {
    const tagItem = buildThreadActionMenuItems({
      ...baseState,
      currentTag: "billing",
      tagNames: ["Billing", "Support"],
    }).find((item) => item.id === "tag");
    expect(tagItem).toMatchObject({ label: "Move to tag", icon: "folder" });
    expect(
      tagItem?.children?.map((child) => [child.id, child.label, child.checked ?? null]),
    ).toEqual([
      // The thread stores another spelling of "Billing"; it is still that tag.
      ["tag:pick:0", "Billing", true],
      ["tag:pick:1", "Support", false],
      ["tag:new", "New tag…", null],
    ]);
    expect(tagItem?.children?.at(-1)?.separatorBefore).toBe(true);
  });

  it("offers Remove from tag only when the thread has a tag", () => {
    const idsFor = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).map((item) => item.id);
    expect(idsFor(baseState)).not.toContain("untag");
    const tagged = idsFor({ ...baseState, currentTag: "Billing", tagNames: ["Billing"] });
    expect(tagged.slice(tagged.indexOf("tag"), tagged.indexOf("tag") + 2)).toEqual([
      "tag",
      "untag",
    ]);
  });

  it("hides every tag item when the environment lacks tags", () => {
    const withoutTags = buildThreadActionMenuItems({
      ...baseState,
      currentTag: "Billing",
      tagNames: ["Billing"],
      supports: { ...baseState.supports, tags: false },
    }).flatMap((item) => [item.id, ...(item.children ?? []).map((child) => child.id)]);
    expect(withoutTags.filter((id) => id.startsWith("tag") || id === "untag")).toEqual([]);
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});
