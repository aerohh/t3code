import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildScreenGallery, markdownGalleryImages } from "./screenGallery.ts";

const minute = (number: number) => String(number).padStart(2, "0");
const shot = (number: number) => ({
  messageId: MessageId.make(`message-${number}`),
  src: `/shots/${number}.png`,
  note: `shot ${number}`,
  takenAt: `2026-10-26T10:${minute(number)}:00.000Z`,
});
const minuteAfterShot = (number: number) => `2026-10-26T10:${minute(number)}:30.000Z`;

describe("markdownGalleryImages", () => {
  it("reads the screen name and before mark from the title and ignores images inside code", () => {
    const markdown = [
      '![Save button is grey](/shots/0.png "Before: Settings page")',
      '![Save button is blue](/shots/a.png "Gallery: Settings page")',
      "![Plain picture](/shots/b.png)",
      "```md",
      '![Example](/shots/c.png "Gallery: Settings page")',
      "```",
    ].join("\n\n");

    expect(markdownGalleryImages(markdown)).toEqual([
      { src: "/shots/0.png", note: "Save button is grey", screen: "Settings page", isBefore: true },
      {
        src: "/shots/a.png",
        note: "Save button is blue",
        screen: "Settings page",
        isBefore: false,
      },
      { src: "/shots/b.png", note: "Plain picture", screen: null, isBefore: false },
    ]);
  });
});

describe("buildScreenGallery", () => {
  it("shows the first shot, the shot at each push, and the newest unpushed shot", () => {
    const shots = Array.from({ length: 10 }, (_, index) => ({
      shot: shot(index + 1),
      screen: "Settings page",
      isBefore: false,
    }));

    const gallery = buildScreenGallery({
      shots,
      pushTimes: [minuteAfterShot(7), minuteAfterShot(4)],
    });

    expect(gallery.screens).toEqual([
      {
        name: "Settings page",
        before: shot(1),
        pushes: [
          { pushedAt: minuteAfterShot(4), shot: shot(4) },
          { pushedAt: minuteAfterShot(7), shot: shot(7) },
        ],
        notPushedYet: shot(10),
      },
    ]);
  });

  it("skips a push when the screen got no new shot since the one already shown", () => {
    const gallery = buildScreenGallery({
      shots: [
        { shot: shot(1), screen: "Settings page", isBefore: false },
        { shot: shot(2), screen: "Settings page", isBefore: false },
        { shot: shot(3), screen: "Profile page", isBefore: false },
      ],
      pushTimes: [minuteAfterShot(1), minuteAfterShot(2), minuteAfterShot(3)],
    });

    const settings = gallery.screens.find((screen) => screen.name === "Settings page");
    expect(settings?.pushes).toEqual([{ pushedAt: minuteAfterShot(2), shot: shot(2) }]);
    expect(settings?.notPushedYet).toBeNull();
  });

  it("uses a shot marked as before even when it was taken after the changes", () => {
    const gallery = buildScreenGallery({
      shots: [
        { shot: shot(1), screen: "Chat page", isBefore: false },
        { shot: shot(2), screen: "Chat page", isBefore: false },
        { shot: shot(3), screen: "Chat page", isBefore: true },
        { shot: shot(4), screen: "chat page", isBefore: false },
      ],
      pushTimes: [minuteAfterShot(1)],
    });

    expect(gallery.screens).toEqual([
      {
        name: "Chat page",
        before: shot(3),
        pushes: [{ pushedAt: minuteAfterShot(1), shot: shot(1) }],
        notPushedYet: shot(4),
      },
    ]);
  });
});
