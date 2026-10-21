import type { SourceAgent } from "../../../types";
import { AgentLogo } from "@/components/agent-logo";

export type LegendItem = { key: string; label: string; color: string; source?: SourceAgent; value?: string };

/** Legend keyed by a swatch and, for agents, their logo, so identity never rests on color alone. */
export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-muted-foreground">
      {items.map((item) => (
        <li key={item.key} className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-[2px]" style={{ background: item.color }} />
          {item.source !== undefined || item.key === "unknown" ? <AgentLogo source={item.source} size={13} /> : null}
          <span>{item.label}</span>
          {item.value && <span className="tabular text-foreground">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}
