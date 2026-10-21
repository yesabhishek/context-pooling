import * as React from "react";
import type { HandoffListItem } from "../../../types";
import { AGENTS, agentColor, agentName } from "@/lib/agents";
import { shortDate, timeAgo } from "@/lib/format";
import type { TimeRange } from "@/lib/range";
import { navigate } from "@/lib/router";
import { AgentLogo } from "@/components/agent-logo";
import { ChartTooltip, useWidth, type TooltipState } from "@/components/ui/tooltip";

const ROW = 40;
const LABEL = 168;
const MARK = 22;
const PAD = 14;
const MAX_ROWS = 8;

type Group = { x: number; items: HandoffListItem[] };
type Lane = { task: string; groups: Group[]; agents: number; count: number };

/**
 * One lane per task across time. Each mark is a handoff, drawn with the logo of the agent it came from;
 * the line between two marks shifts color where the work moved from one agent to another.
 */
export function RelayMap({ handoffs, range }: { handoffs: HandoffListItem[]; range: TimeRange }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tooltip, setTooltip] = React.useState<TooltipState>();
  const gradientId = React.useId().replace(/[^\w-]/g, "");
  const label = width < 520 ? 104 : LABEL;
  const plotStart = label + PAD;
  const plotEnd = Math.max(plotStart + 1, width - PAD);
  const x = React.useCallback((time: number) => plotStart + ((time - range.start) / Math.max(1, range.end - range.start)) * (plotEnd - plotStart), [plotStart, plotEnd, range]);

  const lanes = React.useMemo<Lane[]>(() => {
    const byTask = new Map<string, HandoffListItem[]>();
    for (const handoff of handoffs) byTask.set(handoff.task, [...(byTask.get(handoff.task) || []), handoff]);
    return Array.from(byTask, ([task, items]) => {
      const sorted = [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const groups: Group[] = [];
      for (const item of sorted) {
        const position = x(Date.parse(item.createdAt));
        const last = groups.at(-1);
        // Marks closer than one logo apart collapse into a group so they never overlap.
        if (last && position - last.x < MARK + 2) last.items.push(item);
        else groups.push({ x: position, items: [item] });
      }
      return { task, groups, agents: new Set(sorted.flatMap((item) => (item.source ? [item.source] : []))).size, count: sorted.length };
    })
      .sort((a, b) => Date.parse(b.groups.at(-1)!.items.at(-1)!.createdAt) - Date.parse(a.groups.at(-1)!.items.at(-1)!.createdAt))
      .slice(0, MAX_ROWS);
  }, [handoffs, x]);

  const totalTasks = new Set(handoffs.map((handoff) => handoff.task)).size;
  const height = lanes.length * ROW + 26;
  const ticks = timeTicks(range, Math.max(2, Math.floor((plotEnd - plotStart) / 110)));

  function show(group: Group, laneIndex: number) {
    setTooltip({
      x: group.x,
      y: laneIndex * ROW + ROW / 2 - MARK / 2,
      content: (
        <div className="max-w-[280px] space-y-2">
          {group.items
            .slice(-4)
            .reverse()
            .map((item) => (
              <div key={item.id}>
                <div className="flex items-center gap-1.5">
                  <AgentLogo source={item.source} size={13} />
                  <span className="font-medium">{agentName(item.source)}</span>
                  <span className="ml-auto pl-3 text-[11.5px] text-faint">{timeAgo(item.createdAt)}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-muted-foreground">{item.title || item.nextAction}</p>
              </div>
            ))}
          {group.items.length > 4 && <p className="text-[11.5px] text-faint">and {group.items.length - 4} earlier</p>}
        </div>
      )
    });
  }

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setTooltip(undefined)}>
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" role="list" aria-label="Handoffs per task over time">
          <defs>
            {lanes.flatMap((lane, laneIndex) =>
              lane.groups.slice(1).map((group, index) => {
                const from = lane.groups[index];
                return (
                  <linearGradient key={`${laneIndex}-${index}`} id={`${gradientId}-${laneIndex}-${index}`} gradientUnits="userSpaceOnUse" x1={from.x} x2={group.x} y1={0} y2={0}>
                    <stop offset="0.15" stopColor={agentColor(from.items.at(-1)!.source)} />
                    <stop offset="0.85" stopColor={agentColor(group.items[0].source)} />
                  </linearGradient>
                );
              })
            )}
          </defs>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={x(tick)} x2={x(tick)} y1={0} y2={lanes.length * ROW} stroke="var(--grid)" shapeRendering="crispEdges" />
              <text x={x(tick)} y={lanes.length * ROW + 17} textAnchor="middle" className="fill-faint text-[11px]">
                {shortDate(new Date(tick).toISOString())}
              </text>
            </g>
          ))}
          {lanes.map((lane, laneIndex) => {
            const cy = laneIndex * ROW + ROW / 2;
            return (
              <g key={lane.task} role="listitem" aria-label={`${lane.task}: ${lane.count} handoffs from ${lane.agents} ${lane.agents === 1 ? "agent" : "agents"}`}>
                <line x1={plotStart - 4} x2={plotEnd} y1={cy} y2={cy} stroke="var(--grid)" strokeWidth={1} />
                <foreignObject x={0} y={cy - 16} width={label} height={32}>
                  <div className="flex h-full flex-col justify-center leading-tight">
                    <span className="truncate text-[12.5px] font-medium text-foreground" title={lane.task}>
                      {lane.task}
                    </span>
                    <span className="truncate text-[11.5px] text-faint">
                      {lane.count} {lane.count === 1 ? "handoff" : "handoffs"}
                      {lane.agents > 1 ? `, ${lane.agents} agents` : ""}
                    </span>
                  </div>
                </foreignObject>
                {lane.groups.slice(1).map((group, index) => {
                  const from = lane.groups[index];
                  const switched = from.items.at(-1)!.source !== group.items[0].source;
                  return (
                    <line
                      key={index}
                      x1={from.x + MARK / 2}
                      x2={group.x - MARK / 2}
                      y1={cy}
                      y2={cy}
                      stroke={switched ? `url(#${gradientId}-${laneIndex}-${index})` : agentColor(group.items[0].source)}
                      strokeWidth={2}
                      strokeLinecap="round"
                      opacity={switched ? 1 : 0.55}
                    />
                  );
                })}
                {lane.groups.map((group) => {
                  const latest = group.items.at(-1)!;
                  const info = latest.source ? AGENTS[latest.source] : undefined;
                  return (
                    <g
                      key={latest.id}
                      className="cursor-pointer outline-none [&:focus-visible>rect:first-of-type]:stroke-[var(--ring)] [&:hover>rect:first-of-type]:stroke-[var(--border-strong)]"
                      tabIndex={0}
                      role="link"
                      aria-label={`${agentName(latest.source)} handoff for ${lane.task}, ${timeAgo(latest.createdAt)}`}
                      onPointerEnter={() => show(group, laneIndex)}
                      onFocus={() => show(group, laneIndex)}
                      onBlur={() => setTooltip(undefined)}
                      onClick={() => navigate(`/handoffs/${latest.id}`)}
                      onKeyDown={(event) => event.key === "Enter" && navigate(`/handoffs/${latest.id}`)}
                    >
                      <rect x={group.x - MARK / 2} y={cy - MARK / 2} width={MARK} height={MARK} rx={6} fill="var(--background)" stroke="var(--border)" strokeWidth={1.5} />
                      {info ? (
                        <image href={info.logo} x={group.x - 6.5} y={cy - 6.5} width={13} height={13} />
                      ) : (
                        <circle cx={group.x} cy={cy} r={3.5} fill="var(--agent-unknown)" />
                      )}
                      {group.items.length > 1 && (
                        <g>
                          <rect x={group.x + 4} y={cy - MARK / 2 - 6} width={group.items.length > 9 ? 18 : 14} height={13} rx={6.5} fill="var(--ink)" stroke="var(--background)" strokeWidth={2} />
                          <text x={group.x + 4 + (group.items.length > 9 ? 9 : 7)} y={cy - MARK / 2 + 0.5} textAnchor="middle" dy="0.32em" className="fill-[var(--ink-foreground)] text-[9px] font-semibold">
                            {group.items.length}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      <ChartTooltip state={tooltip} />
      {totalTasks > lanes.length && <p className="mt-1 text-[12px] text-faint">Showing the {lanes.length} most recent of {totalTasks} tasks.</p>}
    </div>
  );
}

function timeTicks(range: TimeRange, count: number): number[] {
  const span = range.end - range.start;
  return Array.from({ length: count + 1 }, (_, index) => range.start + (span * index) / count).slice(1, -1);
}
