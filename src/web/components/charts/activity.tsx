import * as React from "react";
import type { HandoffListItem, SourceAgent } from "../../../types";
import { AGENT_ORDER, AGENTS, agentColor, agentName } from "@/lib/agents";
import { buckets, type TimeRange } from "@/lib/range";
import { AgentLogo } from "@/components/agent-logo";
import { ChartTooltip, useWidth, type TooltipState } from "@/components/ui/tooltip";
import { Legend } from "./legend";

type Series = SourceAgent | "unknown";
const SERIES: Series[] = [...AGENT_ORDER, "unknown"];
const PLOT_HEIGHT = 168;
const AXIS = 24;
const Y_LABELS = 28;

/** Handoffs per day (or week), stacked by the agent they came from. */
export function ActivityChart({ handoffs, range }: { handoffs: HandoffListItem[]; range: TimeRange }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = React.useState<number>();
  const [tooltip, setTooltip] = React.useState<TooltipState>();

  const data = React.useMemo(() => {
    const starts = buckets(range);
    const rows = starts.map((start, index) => {
      const end = starts[index + 1] ?? range.end + 1;
      const counts = Object.fromEntries(SERIES.map((series) => [series, 0])) as Record<Series, number>;
      for (const handoff of handoffs) {
        const time = Date.parse(handoff.createdAt);
        if (time >= start && time < end) counts[handoff.source || "unknown"]++;
      }
      return { start, counts, total: SERIES.reduce((sum, series) => sum + counts[series], 0) };
    });
    const present = SERIES.filter((series) => rows.some((row) => row.counts[series]));
    return { rows, present, max: Math.max(1, ...rows.map((row) => row.total)) };
  }, [handoffs, range]);

  const ticks = niceTicks(data.max);
  const top = ticks[ticks.length - 1];
  const plotWidth = Math.max(0, width - Y_LABELS);
  const slot = data.rows.length ? plotWidth / data.rows.length : 0;
  const barWidth = Math.max(2, Math.min(24, slot * 0.62));
  const y = (value: number) => PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const labelEvery = Math.max(1, Math.ceil(data.rows.length / Math.max(2, Math.floor(plotWidth / 64))));

  function show(index: number | undefined) {
    setActive(index);
    if (index === undefined) return setTooltip(undefined);
    const row = data.rows[index];
    setTooltip({
      x: Y_LABELS + slot * index + slot / 2,
      y: y(row.total) + 4,
      content: (
        <div>
          <div className="mb-1.5 text-[11.5px] text-muted-foreground">{bucketLabel(row.start, range.bucket)}</div>
          {data.present
            .filter((series) => row.counts[series])
            .map((series) => (
              <div key={series} className="flex items-center gap-2 py-0.5">
                <span className="h-0.5 w-2.5 rounded-full" style={{ background: agentColor(series === "unknown" ? undefined : series) }} />
                <AgentLogo source={series === "unknown" ? undefined : series} size={13} />
                <span className="flex-1 text-muted-foreground">{agentName(series === "unknown" ? undefined : series)}</span>
                <span className="tabular font-medium">{row.counts[series]}</span>
              </div>
            ))}
          {!row.total && <div className="text-muted-foreground">No handoffs</div>}
          {data.present.length > 1 && row.total > 0 && (
            <div className="mt-1 flex justify-between border-t border-border pt-1 text-muted-foreground">
              <span>Total</span>
              <span className="tabular font-medium text-foreground">{row.total}</span>
            </div>
          )}
        </div>
      )
    });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const last = data.rows.length - 1;
    const next = active === undefined ? last : Math.min(last, Math.max(0, active + (event.key === "ArrowRight" ? 1 : -1)));
    show(next);
  }

  return (
    <div>
      {data.present.length > 0 && (
        <Legend items={data.present.map((series) => ({ key: series, label: series === "unknown" ? "Local capture" : AGENTS[series].name, color: agentColor(series === "unknown" ? undefined : series), source: series === "unknown" ? undefined : series }))} />
      )}
      <div
        ref={ref}
        className="relative mt-3 outline-none"
        tabIndex={0}
        role="img"
        aria-label={`Handoffs per ${range.bucket}. Use the arrow keys to read each ${range.bucket}.`}
        onKeyDown={onKeyDown}
        onBlur={() => show(undefined)}
        onPointerLeave={() => show(undefined)}
      >
        {width > 0 && (
          <svg width={width} height={PLOT_HEIGHT + AXIS} className="block overflow-visible">
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={Y_LABELS} x2={width} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={Y_LABELS - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="tabular fill-faint text-[11px]">
                  {tick}
                </text>
              </g>
            ))}
            {data.rows.map((row, index) => {
              const x = Y_LABELS + slot * index + (slot - barWidth) / 2;
              let base = PLOT_HEIGHT;
              const stack = data.present.filter((series) => row.counts[series]);
              return (
                <g key={row.start} opacity={active === undefined || active === index ? 1 : 0.45} className="transition-opacity">
                  {stack.map((series, position) => {
                    const height = (row.counts[series] / top) * PLOT_HEIGHT;
                    const topY = base - height;
                    // A 2px surface gap separates stacked segments.
                    const drawnHeight = Math.max(1, height - (position > 0 ? 2 : 0));
                    const segment = position === stack.length - 1 ? roundedTop(x, topY, barWidth, drawnHeight, Math.min(4, barWidth / 2)) : rect(x, topY, barWidth, drawnHeight);
                    base = topY;
                    return <path key={series} d={segment} fill={agentColor(series === "unknown" ? undefined : series)} />;
                  })}
                  {index % labelEvery === 0 && (
                    <text x={Y_LABELS + slot * index + slot / 2} y={PLOT_HEIGHT + 16} textAnchor="middle" className="fill-faint text-[11px]">
                      {axisLabel(row.start, range.bucket, data.rows.length)}
                    </text>
                  )}
                  <rect x={Y_LABELS + slot * index} y={0} width={slot} height={PLOT_HEIGHT} fill="transparent" onPointerEnter={() => show(index)} onPointerMove={() => active !== index && show(index)} />
                </g>
              );
            })}
          </svg>
        )}
        <ChartTooltip state={tooltip} />
      </div>
    </div>
  );
}

function niceTicks(rawMax: number): number[] {
  // A floor of 4 keeps a quiet week from drawing every bar at full height.
  const max = Math.max(4, rawMax);
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 4 / 10) * 10;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: top / step + 1 }, (_, index) => index * step);
}

function rect(x: number, y: number, width: number, height: number): string {
  return `M${x},${y}h${width}v${height}h${-width}Z`;
}

function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function axisLabel(start: number, bucket: "day" | "week", count: number): string {
  const date = new Date(start);
  if (bucket === "day" && count <= 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function bucketLabel(start: number, bucket: "day" | "week"): string {
  const date = new Date(start);
  const label = date.toLocaleDateString(undefined, { weekday: bucket === "day" ? "short" : undefined, month: "short", day: "numeric" });
  return bucket === "week" ? `Week of ${label}` : label;
}
