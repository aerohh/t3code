import { describe, expect, it } from "vite-plus/test";
import { createChatCanvasStore, type ChatCanvasMeasurements } from "./canvasStore";

const measurements = (width: number, height = 900): ChatCanvasMeasurements => ({
  width,
  height,
  padding: 48,
  maxChatWidth: 768,
  minChatWidth: 640,
  composerHeight: 180,
  timelineGutter: 0,
  findBar: null,
});

describe("chat canvas store", () => {
  it("keeps state identity when a measurement repeats", () => {
    const store = createChatCanvasStore();
    store.getState().setMeasurements(measurements(1400));
    const before = store.getState();
    store.getState().setMeasurements(measurements(1400));
    expect(store.getState()).toBe(before);
  });
});
