import { terminalOutputPlainText } from "@t3tools/shared/terminalOutput";

/**
 * Progress of a background command, read from its newest output line. Only "142/380",
 * "142 of 380" and "37%" count, and only once a later line confirms them without going
 * backwards, so a lone "1/2" inside a path or a date never shows as progress.
 */

/** The strip shows one line; anything longer is cut. */
const MAX_LINE_CHARS = 200;
/** Time left follows how fast the most recent stretch went. */
const RATE_WINDOW_MS = 120_000;
/** No guess until progress has moved for this long, so the first jump can't mislead. */
const MIN_RATE_SPAN_MS = 10_000;
/** Samples closer together than this replace each other, bounding the window's size. */
const SAMPLE_SPACING_MS = 1_000;

const COUNT_PATTERN = /(?<![\w./:-])(\d{1,7})(?:\s*\/\s*|\s+of\s+)(\d{1,7})(?![\w./:])/u;
const PERCENT_PATTERN = /(?<![\w.])(\d{1,3}(?:\.\d+)?)\s?%/u;

interface ProgressReading {
  readonly kind: "count" | "percent";
  /** A count's total. A different total is a new stage, not progress on the old one. */
  readonly total: number | null;
  readonly fraction: number;
}

interface ProgressSample {
  readonly at: number;
  readonly fraction: number;
}

export interface BackgroundCommandProgressState {
  readonly line: string | null;
  /** The latest reading, trusted or not; the next one must continue it. */
  readonly latestReading: ProgressReading | null;
  readonly trustedReading: ProgressReading | null;
  readonly samples: ReadonlyArray<ProgressSample>;
}

export interface BackgroundCommandProgressView {
  readonly line: string | null;
  readonly percent: number | null;
  readonly secondsLeft: number | null;
}

export const EMPTY_BACKGROUND_COMMAND_PROGRESS: BackgroundCommandProgressState = {
  line: null,
  latestReading: null,
  trustedReading: null,
  samples: [],
};

/** The last non-blank line of shown terminal output, without colour codes. */
export function newestOutputLine(text: string): string | null {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = terminalOutputPlainText(text.slice(start, end)).trim();
    if (line.length > 0) return line.slice(0, MAX_LINE_CHARS);
    end = start - 1;
  }
  return null;
}

function readProgressFromLine(line: string): ProgressReading | null {
  const percent = PERCENT_PATTERN.exec(line);
  if (percent !== null) {
    const value = Number(percent[1]);
    if (value <= 100) return { kind: "percent", total: null, fraction: value / 100 };
  }
  const count = COUNT_PATTERN.exec(line);
  if (count === null) return null;
  const done = Number(count[1]);
  const total = Number(count[2]);
  if (total === 0 || done > total) return null;
  return { kind: "count", total, fraction: done / total };
}

function continuesReading(previous: ProgressReading | null, next: ProgressReading): boolean {
  return (
    previous !== null &&
    previous.kind === next.kind &&
    previous.total === next.total &&
    next.fraction >= previous.fraction
  );
}

function addSample(
  samples: ReadonlyArray<ProgressSample>,
  sample: ProgressSample,
): ReadonlyArray<ProgressSample> {
  const recent = samples.filter((entry) => entry.at >= sample.at - RATE_WINDOW_MS);
  const last = recent.at(-1);
  if (last !== undefined && sample.at - last.at < SAMPLE_SPACING_MS) {
    return [...recent.slice(0, -1), sample];
  }
  return [...recent, sample];
}

export function updateBackgroundCommandProgress(
  state: BackgroundCommandProgressState,
  line: string | null,
  now: number,
): BackgroundCommandProgressState {
  // The tail is re-read on every chunk, so an unchanged newest line is not a new reading.
  if (line === state.line) return state;
  const reading = line === null ? null : readProgressFromLine(line);
  // Lines without a number (a warning, a file name) leave the progress where it was.
  if (reading === null) return { ...state, line };
  const sample = { at: now, fraction: reading.fraction };
  if (!continuesReading(state.latestReading, reading)) {
    return { line, latestReading: reading, trustedReading: null, samples: [sample] };
  }
  return {
    line,
    latestReading: reading,
    trustedReading: reading,
    samples: addSample(state.samples, sample),
  };
}

function estimateSecondsLeft(samples: ReadonlyArray<ProgressSample>, now: number): number | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined || last.fraction >= 1) return null;
  // Progress that stalled this long says nothing about the time left.
  if (now - last.at > RATE_WINDOW_MS) return null;
  const span = last.at - first.at;
  const gained = last.fraction - first.fraction;
  if (span < MIN_RATE_SPAN_MS || gained <= 0) return null;
  const msLeft = ((1 - last.fraction) * span) / gained - (now - last.at);
  return Math.max(0, Math.round(msLeft / 1000));
}

export function presentBackgroundCommandProgress(
  state: BackgroundCommandProgressState,
  now: number,
): BackgroundCommandProgressView {
  if (state.trustedReading === null) {
    return { line: state.line, percent: null, secondsLeft: null };
  }
  return {
    line: state.line,
    percent: Math.floor(state.trustedReading.fraction * 100),
    secondsLeft: estimateSecondsLeft(state.samples, now),
  };
}
