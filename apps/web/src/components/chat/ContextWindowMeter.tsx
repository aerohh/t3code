import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatResetsIn } from "@t3tools/shared/usageLimits";
import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
} from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { composerFloatingLayerProps } from "./composerEventScope";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

// Mixed toward the background so the limit ring stays quieter than the context ring.
function fiveHourLimitColor(usedPercent: number): string {
  if (usedPercent >= 90) {
    return "color-mix(in oklab, var(--color-error) 40%, var(--color-background))";
  }
  if (usedPercent >= 75) {
    return "color-mix(in oklab, var(--color-warning) 40%, var(--color-background))";
  }
  return "color-mix(in oklab, color-mix(in oklab, var(--color-info) 35%, var(--color-muted-foreground)) 55%, var(--color-background))";
}

function MeterRing(props: {
  radius: number;
  strokeWidth: number;
  percentage: number;
  color: string;
}) {
  const circumference = 2 * Math.PI * props.radius;
  const dashOffset = circumference * (1 - props.percentage / 100);
  return (
    <>
      <circle
        cx="12"
        cy="12"
        r={props.radius}
        fill="none"
        className="stroke-muted-foreground/24"
        strokeWidth={props.strokeWidth}
      />
      {props.percentage > 0 ? (
        <circle
          cx="12"
          cy="12"
          r={props.radius}
          fill="none"
          stroke={props.color}
          strokeWidth={props.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
        />
      ) : null}
    </>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  fiveHourWindow: ServerProviderUsageWindow | null;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const {
    usage,
    fiveHourWindow,
    modelDisplayName,
    onCompact,
    compactDisabled,
    compactDisabledReason,
  } = props;
  const usedPercentage = usage ? formatPercentage(usage.usedPercentage) : null;
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const fiveHourUsedPercentage = fiveHourWindow
    ? Math.max(0, Math.min(100, fiveHourWindow.usedPercent))
    : 0;
  const fiveHourColor = fiveHourLimitColor(fiveHourUsedPercentage);
  const contextAriaLabel = usage
    ? usage.maxTokens !== null && usedPercentage
      ? `Context window ${usedPercentage} used`
      : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
    : null;
  const fiveHourAriaLabel = fiveHourWindow
    ? `5-hour limit ${Math.round(fiveHourUsedPercentage)}% used`
    : null;
  const nowMinute = useNowMinute();
  const resetsIn = fiveHourWindow
    ? formatResetsIn(fiveHourWindow, Date.parse(`${nowMinute}:00.000Z`))
    : null;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className={fiveHourWindow ? "size-8 sm:size-8" : "size-7"}
            aria-label={[contextAriaLabel, fiveHourAriaLabel].filter(Boolean).join(", ")}
          >
            <span
              className={cn(
                "relative flex items-center justify-center",
                fiveHourWindow ? "size-7.5" : "size-5",
              )}
            >
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                {fiveHourWindow ? (
                  <>
                    <MeterRing
                      radius={10.75}
                      strokeWidth={2}
                      percentage={normalizedPercentage}
                      color={usageColor}
                    />
                    <MeterRing
                      radius={5.25}
                      strokeWidth={2}
                      percentage={fiveHourUsedPercentage}
                      color={fiveHourColor}
                    />
                  </>
                ) : (
                  <MeterRing
                    radius={9.75}
                    strokeWidth={3}
                    percentage={normalizedPercentage}
                    color={usageColor}
                  />
                )}
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          {usage ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-muted-foreground text-xs">Context Window</div>
                {usage.maxTokens !== null && usedPercentage ? (
                  <div className="text-secondary-label text-2xs tabular-nums">
                    <span>{usedPercentage}</span>
                    <span className="mx-1">·</span>
                    <span>
                      {formatContextWindowTokens(usage.usedTokens)}/
                      {formatContextWindowTokens(usage.maxTokens ?? null)}
                    </span>
                  </div>
                ) : (
                  <div className="text-secondary-label text-2xs tabular-nums">
                    {formatContextWindowTokens(usage.usedTokens)}
                  </div>
                )}
              </div>
              {usage.maxTokens !== null ? (
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(normalizedPercentage)}
                  aria-label="Context window usage"
                >
                  <div
                    className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                    style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
                  />
                </div>
              ) : null}
              {showTotalProcessed ? (
                <div className="flex items-center justify-between gap-3 text-2xs leading-4">
                  <span className="text-secondary-label">Total processed</span>
                  <span className="font-medium tabular-nums text-secondary-label">
                    {formatContextWindowTokens(totalProcessedTokens)}
                  </span>
                </div>
              ) : null}
              {usage.cost != null ? (
                <div className="flex items-center justify-between gap-3 text-2xs leading-4">
                  <span className="text-secondary-label">Cost</span>
                  <span className="font-medium tabular-nums text-secondary-label">
                    {formatContextWindowCost(usage.cost)}
                  </span>
                </div>
              ) : null}
              {usage.compactsAutomatically ? (
                <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
                  {formatContextWindowCompactionMessage(
                    modelDisplayName,
                    usage.autoCompactThreshold,
                  )}
                </div>
              ) : null}
            </>
          ) : null}
          {fiveHourWindow ? (
            <>
              <div className={cn("flex items-center justify-between gap-3", usage && "mt-1")}>
                <div className="font-medium text-muted-foreground text-xs">5-hour limit</div>
                <div className="text-secondary-label text-2xs tabular-nums">
                  {Math.round(fiveHourUsedPercentage)}% used
                </div>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(fiveHourUsedPercentage)}
                aria-label="5-hour limit usage"
              >
                <div
                  className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                  style={{ width: `${fiveHourUsedPercentage}%`, backgroundColor: fiveHourColor }}
                />
              </div>
              {resetsIn ? (
                <div className="text-pretty text-secondary-label text-2xs first-letter:uppercase">
                  {resetsIn}
                </div>
              ) : null}
            </>
          ) : null}
          {usage && onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
