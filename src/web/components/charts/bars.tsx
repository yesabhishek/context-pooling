import * as React from "react";
import { Check, CircleDashed, X } from "lucide-react";
import type { HandoffListItem, SourceAgent } from "../../../types";
import { AGENT_ORDER, AGENTS, agentColor } from "@/lib/agents";
import { compact, percent, splitPath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentTile } from "@/components/agent-logo";

/** Share of handoffs and context per agent, as a bar list with each agent's logo. */
export function AgentBreakdown({ handoffs }: { handoffs: HandoffListItem[] }) {
  const rows = React.useMemo(() => {
    const totals = new Map<SourceAgent | undefined, { count: number; tokens: number }>();
    for (const handoff of handoffs) {
      const entry = totals.get(handoff.source) || { count: 0, tokens: 0 };
      entry.count++;
      entry.tokens += handoff.tokens;
      totals.set(handoff.source, entry);
    }
    return [...AGENT_ORDER, undefined].filter((source) => totals.has(source)).map((source) => ({ source, ...totals.get(source)! })).sort((a, b) => b.count - a.count);
  }, [handoffs]);
  const max = Math.max(1, ...rows.map((row) => row.count));

  if (!rows.length) return <p className="py-6 text-center text-[13px] text-faint">No handoffs in this range.</p>;
  return (
    <ul className="space-y-3.5">
      {rows.map((row) => (
        <li key={row.source || "unknown"} className="flex items-center gap-3">
          <AgentTile source={row.source} size={30} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2 text-[13px]">
              <span className="truncate font-medium">{row.source ? AGENTS[row.source].name : "Local capture"}</span>
              <span className="tabular shrink-0 text-muted-foreground">
                <span className="font-medium text-foreground">{row.count}</span>
                <span className="ml-1.5 text-faint">{percent(row.count, handoffs.length)}</span>
              </span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${(row.count / max) * 100}%`, background: agentColor(row.source) }} />
            </div>
            <div className="mt-1 text-[11.5px] text-faint">~{compact(row.tokens)} tokens of context</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

const VERIFICATION = [
  { key: "passed", label: "Checks passed", icon: Check, color: "var(--good)" },
  { key: "failed", label: "Checks failed", icon: X, color: "var(--bad)" },
  { key: "unknown", label: "Not verified", icon: CircleDashed, color: "var(--border-strong)" }
] as const;

/** Part-to-whole of how each handoff left its checks. */
export function VerificationBreakdown({ handoffs }: { handoffs: HandoffListItem[] }) {
  const counts = { passed: 0, failed: 0, unknown: 0 };
  for (const handoff of handoffs) counts[handoff.verification]++;
  const total = handoffs.length;
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-muted" role="img" aria-label={VERIFICATION.map((item) => `${counts[item.key]} ${item.label.toLowerCase()}`).join(", ")}>
        {VERIFICATION.map((item) =>
          counts[item.key] ? <div key={item.key} title={`${item.label}: ${counts[item.key]}`} style={{ flexGrow: counts[item.key], background: item.color }} className="h-full first:rounded-l-full last:rounded-r-full" /> : null
        )}
      </div>
      <ul className="mt-3 grid grid-cols-3 gap-2">
        {VERIFICATION.map((item) => (
          <li key={item.key} className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <item.icon className="size-3.5 shrink-0" style={{ color: item.key === "unknown" ? "var(--faint)" : item.color }} strokeWidth={2.5} />
              <span className="truncate">{item.label}</span>
            </div>
            <div className="mt-0.5 text-[18px] font-semibold tracking-[-0.01em]">
              {counts[item.key]}
              <span className="ml-1 text-[12px] font-normal text-faint">{percent(counts[item.key], total)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Files that show up in the most handoffs: where the work keeps returning. */
export function HotFiles({ handoffs, limit = 6 }: { handoffs: HandoffListItem[]; limit?: number }) {
  const rows = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const handoff of handoffs) for (const path of new Set(handoff.files.paths)) counts.set(path, (counts.get(path) || 0) + 1);
    return Array.from(counts, ([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, limit);
  }, [handoffs, limit]);
  const max = Math.max(1, ...rows.map((row) => row.count));
  if (!rows.length) return <p className="py-6 text-center text-[13px] text-faint">No changed files in this range.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const { dir, name } = splitPath(row.path);
        return (
          <li key={row.path} className="grid grid-cols-[minmax(0,1fr)_88px_24px] items-center gap-3 text-[12.5px]">
            <span className="truncate font-mono text-[12px]" title={row.path}>
              <span className="text-faint">{dir}</span>
              {name}
            </span>
            <span className="h-1.5 rounded-full bg-muted">
              <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${(row.count / max) * 100}%` }} />
            </span>
            <span className="tabular text-right text-muted-foreground">{row.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Tiny trend line for a stat tile; the latest point is emphasized. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const width = 88;
  const height = 26;
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => [(index / (values.length - 1)) * (width - 4) + 2, height - 3 - (value / max) * (height - 6)] as const);
  const last = points[points.length - 1];
  return (
    <svg width={width} height={height} className={cn("overflow-visible", className)} aria-hidden>
      <polyline points={points.map((point) => point.join(",")).join(" ")} fill="none" stroke="var(--faint)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill="var(--foreground)" stroke="var(--background)" strokeWidth={1.5} />
    </svg>
  );
}

/** Progress meter; the in-progress share sits between done and the track. */
export function Meter({ value, partial = 0, total, className }: { value: number; partial?: number; total: number; className?: string }) {
  const done = total ? (value / total) * 100 : 0;
  const doing = total ? (partial / total) * 100 : 0;
  return (
    <div className={cn("flex h-1.5 overflow-hidden rounded-full bg-muted", className)} role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
      <div className="h-full bg-good" style={{ width: `${done}%` }} />
      {doing > 0 && <div className="h-full bg-good/35" style={{ width: `${doing}%` }} />}
    </div>
  );
}

/** GitHub-style five-block diff summary. */
export function DiffBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const green = total ? Math.round((additions / total) * 5) : 0;
  const red = total ? Math.min(5 - green, Math.max(deletions ? 1 : 0, Math.round((deletions / total) * 5))) : 0;
  return (
    <span className="inline-flex gap-[2px]" aria-hidden>
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} className={cn("size-2 rounded-[2px]", index < green ? "bg-good" : index < green + red ? "bg-bad" : "bg-muted")} />
      ))}
    </span>
  );
}

export function DiffCount({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn("tabular inline-flex gap-1.5 font-mono text-[12px]", className)}>
      <span className="text-good">+{compact(additions)}</span>
      <span className="text-bad">−{compact(deletions)}</span>
    </span>
  );
}
