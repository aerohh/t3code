import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
  resolveContextWindowModelDisplayName,
  selectFiveHourUsageWindow,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";

function claudeProvider(input: {
  instanceId: string;
  continuationGroupKey: string;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: input.continuationGroupKey },
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: [{ name: "compact", description: "" }],
    skills: [],
  };
}

describe("hasAvailableCompactionProvider", () => {
  const originalInstanceId = ProviderInstanceId.make("claude_original");

  it("rejects a fallback in a different locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_other",
        continuationGroupKey: "claude:home:/other",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(false);
  });

  it("accepts an enabled fallback in the locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_fallback",
        continuationGroupKey: "claude:home:/original",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(true);
  });
});

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("5.6 Sol");
  });
});

describe("hasDismissedResumeCompaction", () => {
  it("recognizes the native resume dialog's permanent dismissal", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is 2h 0m old and uses 250,000 tokens. Compact it before continuing?":
                "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("ignores unrelated questions that end with Claude's compaction prompt", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "The build cache is large. Compact it before continuing?": "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    threadStarted: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });
});

describe("selectFiveHourUsageWindow", () => {
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const withWindows = (windows: NonNullable<ServerProvider["usageLimits"]>["windows"]) => ({
    ...claudeProvider({ instanceId: "claudeAgent", continuationGroupKey: "claude:home" }),
    usageLimits: { checkedAt: "2026-10-22T11:00:00.000Z", windows },
  });

  it("picks the fullest 5-hour window and ignores weekly limits", () => {
    const provider = withWindows([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 95,
        windowDurationMins: 7 * 24 * 60,
      },
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini · 5-hour",
        usedPercent: 20,
        resetsAt: "2026-10-22T14:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        id: "3p-5h",
        kind: "session",
        label: "Claude & GPT · 5-hour",
        usedPercent: 60,
        resetsAt: "2026-10-22T14:00:00.000Z",
        windowDurationMins: 300,
      },
    ]);

    expect(selectFiveHourUsageWindow(provider, now)?.id).toBe("3p-5h");
  });

  it("hides the ring until half the limit is used, and after the limit resets", () => {
    const fiveHourWindow = (usedPercent: number, resetsAt: string) => ({
      id: "five_hour",
      kind: "session" as const,
      label: "Session",
      usedPercent,
      resetsAt,
      windowDurationMins: 300,
    });

    expect(
      selectFiveHourUsageWindow(withWindows([fiveHourWindow(49, "2026-10-22T14:00:00.000Z")]), now),
    ).toBeNull();
    expect(
      selectFiveHourUsageWindow(withWindows([fiveHourWindow(50, "2026-10-22T14:00:00.000Z")]), now)
        ?.usedPercent,
    ).toBe(50);
    expect(
      selectFiveHourUsageWindow(withWindows([fiveHourWindow(93, "2026-10-22T11:30:00.000Z")]), now),
    ).toBeNull();
  });
});
