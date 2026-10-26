import type {
  ScreenGallery,
  ScreenGalleryPush,
  ScreenGalleryScreen,
  ScreenGalleryShot,
} from "@t3tools/contracts";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface MarkdownGalleryImage {
  readonly src: string;
  readonly note: string;
  /** Null when the image has no `Gallery: <screen name>` or `Before: <screen name>` title. */
  readonly screen: string | null;
  readonly isBefore: boolean;
}

export interface LabelledScreenGalleryShot {
  readonly shot: ScreenGalleryShot;
  readonly screen: string | null;
  readonly isBefore: boolean;
}

interface MarkdownNode {
  readonly type: string;
  readonly url?: string;
  readonly alt?: string | null;
  readonly title?: string | null;
  readonly children?: ReadonlyArray<MarkdownNode>;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const GALLERY_TITLE_PATTERN = /^\s*(gallery|before)\s*:\s*(.+?)\s*$/i;

export function markdownGalleryImages(markdown: string): MarkdownGalleryImage[] {
  if (!markdown.includes("![")) return [];
  const images: MarkdownGalleryImage[] = [];
  const collectImages = (node: MarkdownNode) => {
    if (node.type === "image" && node.url) {
      const label = node.title?.match(GALLERY_TITLE_PATTERN);
      images.push({
        src: node.url,
        note: node.alt?.trim() ?? "",
        screen: label?.[2] ?? null,
        isBefore: label?.[1]?.toLowerCase() === "before",
      });
      return;
    }
    for (const child of node.children ?? []) collectImages(child);
  };
  collectImages(markdownParser.parse(markdown) as MarkdownNode);
  return images;
}

/**
 * Shots must be in chat order. A screen's before shot is its first `Before:` shot, or its first
 * shot when none is marked; agents sometimes take the before shot late, so time cannot decide it.
 * Each push shows the screen's newest other shot taken at or before it, and is dropped when that
 * shot is already an earlier push's shot.
 */
export function buildScreenGallery(input: {
  readonly shots: ReadonlyArray<LabelledScreenGalleryShot>;
  readonly pushTimes: ReadonlyArray<string>;
}): Pick<ScreenGallery, "screens" | "unlabelled"> {
  const pushTimesOldestFirst = input.pushTimes
    .map((pushedAt) => ({ pushedAt, time: Date.parse(pushedAt) }))
    .filter((push) => !Number.isNaN(push.time))
    .sort((left, right) => left.time - right.time);

  // Screen names are matched without case so "Settings page" and "settings page" stay together.
  const shotsByScreen = new Map<
    string,
    { name: string; shots: Array<{ shot: ScreenGalleryShot; isBefore: boolean }> }
  >();
  const unlabelled: ScreenGalleryShot[] = [];
  for (const { shot, screen, isBefore } of input.shots) {
    if (screen === null) {
      unlabelled.push(shot);
      continue;
    }
    const key = screen.toLowerCase();
    const existing = shotsByScreen.get(key);
    if (existing) existing.shots.push({ shot, isBefore });
    else shotsByScreen.set(key, { name: screen, shots: [{ shot, isBefore }] });
  }

  const screens: ScreenGalleryScreen[] = [];
  for (const { name, shots } of shotsByScreen.values()) {
    const before = (shots.find((entry) => entry.isBefore) ?? shots[0])?.shot;
    if (!before) continue;
    const laterShots = shots
      .filter((entry) => !entry.isBefore && entry.shot !== before)
      .map((entry) => entry.shot);
    let lastShown: ScreenGalleryShot | null = null;
    const pushes: ScreenGalleryPush[] = [];
    for (const push of pushTimesOldestFirst) {
      const shotAtPush = laterShots.findLast((shot) => Date.parse(shot.takenAt) <= push.time);
      if (!shotAtPush || shotAtPush === lastShown) continue;
      pushes.push({ pushedAt: push.pushedAt, shot: shotAtPush });
      lastShown = shotAtPush;
    }
    const newest = laterShots.at(-1) ?? null;
    screens.push({
      name,
      before,
      pushes,
      notPushedYet: newest === lastShown ? null : newest,
    });
  }

  const newestShotTime = (screen: ScreenGalleryScreen) =>
    Date.parse((screen.notPushedYet ?? screen.pushes.at(-1)?.shot ?? screen.before).takenAt);
  return {
    screens: screens.sort((left, right) => newestShotTime(right) - newestShotTime(left)),
    unlabelled,
  };
}
