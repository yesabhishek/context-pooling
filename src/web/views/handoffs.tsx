import * as React from "react";
import { ArrowLeftRight, Check, ChevronDown, ListFilter, Search, X } from "lucide-react";
import type { HandoffListItem, SourceAgent } from "../../types";
import { AGENT_ORDER, AGENTS, agentName } from "@/lib/agents";
import { useData } from "@/lib/data";
import { dayLabel, plural, startOfDay, timeAgo } from "@/lib/format";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AgentLogo, AgentTile } from "@/components/agent-logo";
import { DiffCount } from "@/components/charts/bars";
import { ChecksBadge, PhaseBadge, RepoLine } from "@/components/handoff-bits";
import { InlineText } from "@/components/inline-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { EmptyState, PageHeader } from "@/components/ui/misc";

type Filters = { q: string; agent?: SourceAgent | "unknown"; task?: string; checks?: "failed" | "passed" | "unknown" };

export function HandoffsView({ query }: { query: URLSearchParams }) {
  const { handoffs, tasks } = useData();
  const filters: Filters = {
    q: query.get("q") || "",
    agent: (query.get("agent") as Filters["agent"]) || undefined,
    task: query.get("task") || undefined,
    checks: (query.get("checks") as Filters["checks"]) || undefined
  };
  const [search, setSearch] = React.useState(filters.q);
  // Follow the URL when it changes from outside (Clear, back button), not when it echoes our own typing.
  const pushed = React.useRef(filters.q);
  React.useEffect(() => {
    const q = query.get("q") || "";
    if (q !== pushed.current) {
      pushed.current = q;
      setSearch(q);
    }
  }, [query]);

  const set = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    navigate("/handoffs", { q: next.q || undefined, agent: next.agent, task: next.task, checks: next.checks }, { replace: true });
  };

  // Debounce typing into the URL so the back button isn't flooded.
  React.useEffect(() => {
    if (search === filters.q) return;
    const timer = window.setTimeout(() => {
      pushed.current = search;
      set({ q: search });
    }, 200);
    return () => window.clearTimeout(timer);
  });

  const visible = React.useMemo(() => filterHandoffs(handoffs, filters), [handoffs, filters.q, filters.agent, filters.task, filters.checks]);
  const groups = React.useMemo(() => groupByDay(visible), [visible]);
  const agentsPresent = React.useMemo(() => [...AGENT_ORDER.filter((agent) => handoffs.some((handoff) => handoff.source === agent)), ...(handoffs.some((handoff) => !handoff.source) ? (["unknown"] as const) : [])], [handoffs]);
  const filtered = Boolean(filters.q || filters.agent || filters.task || filters.checks);

  return (
    <div className="mx-auto w-full max-w-[1160px] px-4 pb-20 pt-8 sm:px-8">
      <PageHeader
        title={filters.task ? filters.task : "Handoffs"}
        description={filters.task ? `${plural(visible.length, "handoff")} for this task` : "Sessions captured with ctxpool handoff, newest first."}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-[320px]">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-faint" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, task, repo, next action" aria-label="Search handoffs" className="pl-8" />
        </div>

        <div role="radiogroup" aria-label="Agent" className="flex h-8 items-center rounded-md border border-border-strong bg-background p-0.5">
          <AgentOption active={!filters.agent} onClick={() => set({ agent: undefined })} label="All agents">
            All
          </AgentOption>
          {agentsPresent.map((agent) => (
            <AgentOption key={agent} active={filters.agent === agent} onClick={() => set({ agent: filters.agent === agent ? undefined : agent })} label={agent === "unknown" ? "Local capture" : AGENTS[agent].name}>
              <AgentLogo source={agent === "unknown" ? undefined : agent} size={15} />
              <span className="hidden lg:inline">{agent === "unknown" ? "Local" : AGENTS[agent].name}</span>
            </AgentOption>
          ))}
        </div>

        <Menu
          align="start"
          className="max-h-[320px] overflow-y-auto"
          trigger={({ toggle, open, ref }) => (
            <Button ref={ref} variant="secondary" onClick={toggle} aria-expanded={open} aria-haspopup="menu" className={cn(filters.task && "border-foreground/40")}>
              <ArrowLeftRight className="text-faint" />
              <span className="max-w-[140px] truncate">{filters.task || "All tasks"}</span>
              <ChevronDown className="text-faint" />
            </Button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={!filters.task ? <Check /> : <span className="size-4" />} onSelect={() => (close(), set({ task: undefined }))}>
                All tasks
              </MenuItem>
              <MenuSeparator />
              {tasks.map((task) => (
                <MenuItem key={task.task} icon={filters.task === task.task ? <Check /> : <span className="size-4" />} hint={task.handoffCount} onSelect={() => (close(), set({ task: task.task }))}>
                  <span className="block truncate">{task.task}</span>
                </MenuItem>
              ))}
            </>
          )}
        </Menu>

        <Menu
          align="start"
          trigger={({ toggle, open, ref }) => (
            <Button ref={ref} variant="secondary" onClick={toggle} aria-expanded={open} aria-haspopup="menu" className={cn(filters.checks && "border-foreground/40")}>
              <ListFilter className="text-faint" />
              {filters.checks === "failed" ? "Failing checks" : filters.checks === "passed" ? "Passing checks" : filters.checks === "unknown" ? "Not verified" : "Any checks"}
              <ChevronDown className="text-faint" />
            </Button>
          )}
        >
          {(close) =>
            (
              [
                [undefined, "Any checks"],
                ["failed", "Failing checks"],
                ["passed", "Passing checks"],
                ["unknown", "Not verified"]
              ] as const
            ).map(([value, label]) => (
              <MenuItem key={label} icon={filters.checks === value ? <Check /> : <span className="size-4" />} onSelect={() => (close(), set({ checks: value }))}>
                {label}
              </MenuItem>
            ))
          }
        </Menu>

        {filtered && (
          <Button size="sm" onClick={() => navigate("/handoffs", {}, { replace: true })}>
            <X /> Clear
          </Button>
        )}
      </div>

      {groups.length ? (
        <div className="overflow-clip rounded-lg border border-border">
          {groups.map((group) => (
            <section key={group.day} aria-label={group.label}>
              <h2 className="sticky top-0 z-10 border-b border-border bg-subtle/95 px-4 py-1.5 text-[12px] font-medium text-muted-foreground backdrop-blur [section+section_&]:border-t">
                {group.label}
              </h2>
              <ul className="divide-y divide-border">
                {group.items.map((item) => (
                  <HandoffRow key={item.id} item={item} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border-strong">
          {filtered ? (
            <EmptyState icon={<Search />} title="No handoffs match" action={<Button variant="secondary" onClick={() => navigate("/handoffs", {}, { replace: true })}>Clear filters</Button>}>
              Try another search, or show every agent and task.
            </EmptyState>
          ) : (
            <EmptyState icon={<ArrowLeftRight />} title="No handoffs yet">
              Run <code className="font-mono">ctxpool handoff</code> in a repo where you’ve used an agent. It will show up here.
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}

function AgentOption({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      role="radio"
      aria-checked={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn("inline-flex h-full items-center gap-1.5 rounded-[5px] px-2 text-[12.5px] font-medium transition-colors", active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {children}
    </button>
  );
}

/** One handoff: agent, what it was, the next action, and its evidence at a glance. */
export function HandoffRow({ item, compact = false }: { item: HandoffListItem; compact?: boolean }) {
  return (
    <li>
      <a href={href(`/handoffs/${item.id}`)} className="group grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-4 py-3 transition-colors hover:bg-hover md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <AgentTile source={item.source} size={32} className="mt-0.5" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] font-medium">{item.title || item.task}</span>
            {item.title && !compact && <span className="hidden shrink-0 truncate text-[12.5px] text-faint sm:inline">{item.task}</span>}
          </div>
          <p className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">
            <InlineText text={item.nextAction} />
          </p>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[12.5px] text-muted-foreground">{agentName(item.source)}</span>
            <RepoLine item={item} />
            <span className="text-[12px] text-faint md:hidden">{timeAgo(item.createdAt)}</span>
          </div>
        </div>
        <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2 md:col-start-3 md:mt-0 md:flex-col md:items-end md:justify-between">
          <span className="hidden text-[12.5px] text-muted-foreground md:block" title={new Date(item.createdAt).toLocaleString()}>
            {timeAgo(item.createdAt)}
          </span>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {item.files.additions + item.files.deletions > 0 ? <DiffCount additions={item.files.additions} deletions={item.files.deletions} /> : item.files.count > 0 && <span className="text-[12px] text-muted-foreground">{plural(item.files.count, "file")}</span>}
            <ChecksBadge checks={item.checks} verification={item.verification} />
            {!compact && <PhaseBadge phase={item.phase} />}
          </div>
        </div>
      </a>
    </li>
  );
}

function filterHandoffs(handoffs: HandoffListItem[], filters: Filters): HandoffListItem[] {
  const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  return handoffs.filter((handoff) => {
    if (filters.agent && (handoff.source || "unknown") !== filters.agent) return false;
    if (filters.task && handoff.task !== filters.task) return false;
    if (filters.checks && handoff.verification !== filters.checks) return false;
    if (!words.length) return true;
    const haystack = `${handoff.title || ""} ${handoff.task} ${handoff.repoName} ${handoff.branch} ${handoff.commit} ${handoff.nextAction} ${handoff.objective} ${agentName(handoff.source)}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

function groupByDay(handoffs: HandoffListItem[]): { day: number; label: string; items: HandoffListItem[] }[] {
  const groups: { day: number; label: string; items: HandoffListItem[] }[] = [];
  for (const handoff of handoffs) {
    const day = startOfDay(Date.parse(handoff.createdAt));
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(handoff);
    else groups.push({ day, label: dayLabel(handoff.createdAt), items: [handoff] });
  }
  return groups;
}
