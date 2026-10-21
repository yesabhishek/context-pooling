import { TerminalSquare } from "lucide-react";
import type { SourceAgent } from "../../types";
import { AGENTS, agentName } from "@/lib/agents";
import { cn } from "@/lib/utils";

/** The agent's own brand mark. Pass `label` when no visible text names the agent. */
export function AgentLogo({ source, size = 16, label, className }: { source?: SourceAgent; size?: number; label?: boolean; className?: string }) {
  const info = source ? AGENTS[source] : undefined;
  if (!info) {
    return <TerminalSquare aria-label={label ? agentName(source) : undefined} aria-hidden={!label} style={{ width: size, height: size }} className={cn("shrink-0 text-faint", className)} />;
  }
  return <img src={info.logo} alt={label ? info.name : ""} title={info.name} width={size} height={size} draggable={false} className={cn("shrink-0 select-none", className)} />;
}

/** The logo on a small neutral tile, so marks of different shapes line up in lists. */
export function AgentTile({ source, size = 28, className, label }: { source?: SourceAgent; size?: number; className?: string; label?: boolean }) {
  return (
    <span style={{ width: size, height: size }} className={cn("inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-background shadow-[0_1px_1px_rgba(0,0,0,0.04)]", className)}>
      <AgentLogo source={source} size={Math.round(size * 0.58)} label={label} />
    </span>
  );
}

/** Overlapping logos for the agents behind a task or pack. */
export function AgentStack({ sources, size = 16, max = 4 }: { sources: (SourceAgent | undefined)[]; size?: number; max?: number }) {
  const unique = Array.from(new Set(sources)).slice(0, max);
  if (!unique.length) return null;
  return (
    <span className="inline-flex items-center" aria-label={unique.map(agentName).join(", ")}>
      {unique.map((source, index) => (
        <span key={source || "unknown"} style={{ width: size + 4, height: size + 4, marginLeft: index ? -6 : 0, zIndex: unique.length - index }} className="relative inline-flex items-center justify-center rounded-full bg-background ring-1 ring-border">
          <AgentLogo source={source} size={size - 2} />
        </span>
      ))}
    </span>
  );
}
