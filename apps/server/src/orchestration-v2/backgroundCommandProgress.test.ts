import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_BACKGROUND_COMMAND_PROGRESS,
  presentBackgroundCommandProgress,
  updateBackgroundCommandProgress,
} from "./backgroundCommandProgress.ts";

function feed(lines: ReadonlyArray<readonly [at: number, line: string]>) {
  return lines.reduce(
    (state, [at, line]) => updateBackgroundCommandProgress(state, line, at),
    EMPTY_BACKGROUND_COMMAND_PROGRESS,
  );
}

describe("background command progress", () => {
  it("shows a count only once a second line confirms it", () => {
    const once = feed([[0, "[142/380] Compiling tab_strip.cc"]]);
    expect(presentBackgroundCommandProgress(once, 0).percent).toBeNull();

    const twice = updateBackgroundCommandProgress(once, "[143/380] Compiling tab.cc", 1_000);
    expect(presentBackgroundCommandProgress(twice, 1_000).percent).toBe(37);
  });

  it("ignores numbers inside paths and dates", () => {
    const state = feed([
      [0, "reading src/1/2/index.ts"],
      [1_000, "reading src/1/3/index.ts"],
      [2_000, "built at 10/25/2026"],
    ]);
    expect(presentBackgroundCommandProgress(state, 2_000)).toEqual({
      line: "built at 10/25/2026",
      percent: null,
      secondsLeft: null,
    });
  });

  it("drops progress that goes backwards until it is confirmed again", () => {
    const state = feed([
      [0, "40%"],
      [1_000, "45%"],
      [2_000, "10%"],
    ]);
    expect(presentBackgroundCommandProgress(state, 2_000).percent).toBeNull();
  });

  it("guesses time left from the recent rate once progress has moved for a while", () => {
    const early = feed([
      [0, "[100/400]"],
      [5_000, "[110/400]"],
    ]);
    expect(presentBackgroundCommandProgress(early, 5_000).secondsLeft).toBeNull();

    // 100 items in 20s is 5 per second, so the 200 left take about 40s.
    const later = updateBackgroundCommandProgress(early, "[200/400]", 20_000);
    expect(presentBackgroundCommandProgress(later, 20_000)).toEqual({
      line: "[200/400]",
      percent: 50,
      secondsLeft: 40,
    });
  });
});
