import * as React from "react";
import { ArrowRight, ChevronRight, Terminal } from "lucide-react";
import type { HandoffListItem } from "../../types";
import { fetchHandoff } from "@/lib/api";
import { AGENT_ORDER, AGENTS, agentName } from "@/lib/agents";
import { useData } from "@/lib/data";
import { compact, percent, plural, timeAgo } from "@/lib/format";
import { buckets, defaultRange, inRange, RANGE_OPTIONS, resolveRange, type RangeKey } from "@/lib/range";
import { href } from "@/lib/router";
import { AgentLogo, AgentTile } from "@/components/agent-logo";
import { ActivityChart } from "@/components/charts/activity";
import { AgentBreakdown, HotFiles, Sparkline, VerificationBreakdown } from "@/components/charts/bars";
import { RelayMap } from "@/components/charts/relay";
import { ChecksBadge, HandoffActions, PhaseBadge, RepoLine } from "@/components/handoff-bits";
import { HandoffRow } from "@/views/handoffs";
import { InlineText } from "@/components/inline-text";
import { Card, CardHeader, Code, PageHeader, Segmented } from "@/components/ui/misc";
import { useCopy } from "@/components/ui/toast";

export function OverviewView() {
  const { handoffs } = useData();
  const [rangeKey, setRangeKey] = React.useState<RangeKey>(() => defaultRange(handoffs));
  const range = React.useMemo(() => resolveRange(rangeKey, handoffs), [rangeKey, handoffs]);
  const scoped = React.useMemo(() => handoffs.filter((handoff) => inRange(handoff, range)), [handoffs, range]);

  if (!handoffs.length) return <Onboarding />;
  const latest = handoffs[0];

  return (
    <div className="mx-auto w-full max-w-[1160px] px-4 pb-20 pt-8 sm:px-8">
      <PageHeader title="Overview" description="Every session you’ve handed off between agents on this machine." />

      <LatestHandoff item={latest} />

      <div className="mb-4 mt-10 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Activity</h2>
        <Segmented label="Time range" value={rangeKey} options={RANGE_OPTIONS} onChange={setRangeKey} />
      </div>

      <div className="space-y-4">
        <Stats handoffs={handoffs} scoped={scoped} rangeKey={rangeKey} />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Handoffs over time" description={`Per ${range.bucket}, by the agent the session came from`} />
            <div className="px-4 pb-4 pt-3">{scoped.length ? <ActivityChart handoffs={scoped} range={range} /> : <NoData />}</div>
          </Card>
          <Card>
            <CardHeader title="Agents" description="Where your sessions come from" />
            <div className="px-4 pb-4 pt-4">
              <AgentBreakdown handoffs={scoped} />
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader title="Relay" description="Each lane is a task. Marks are handoffs; the line changes color where work moved to another agent." />
          <div className="px-4 pb-4 pt-4">{scoped.length ? <RelayMap handoffs={scoped} range={range} /> : <NoData />}</div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Checks at handoff" description="Did the session leave its tests and builds passing?" />
            <div className="px-4 pb-4 pt-4">{scoped.length ? <VerificationBreakdown handoffs={scoped} /> : <NoData />}</div>
          </Card>
          <Card>
            <CardHeader title="Most-handed-off files" description="Files changed in the most handoffs" />
            <div className="px-4 pb-4 pt-4">
              <HotFiles handoffs={scoped} />
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Recent handoffs"
            action={
              <a href="#/handoffs" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
                View all <ChevronRight className="size-3.5" />
              </a>
            }
          />
          <ul className="mt-2 divide-y divide-border border-t border-border">
            {scoped.slice(0, 5).map((handoff) => (
              <HandoffRow key={handoff.id} item={handoff} compact />
            ))}
            {!scoped.length && <li className="px-4 py-6 text-center text-[13px] text-faint">No handoffs in this range.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function LatestHandoff({ item }: { item: HandoffListItem }) {
  const getMarkdown = React.useCallback(() => fetchHandoff(item.id).then((packet) => packet.markdown), [item.id]);
  const getCompact = React.useCallback(() => fetch(`/api/handoffs/${encodeURIComponent(item.id)}/agent-context`).then((response) => response.text()), [item.id]);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-4 p-5">
        <AgentTile source={item.source} size={44} />
        <div className="min-w-[200px] flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
            <span>Latest handoff</span>
            <span className="text-faint">from</span>
            <span className="font-medium text-foreground">{agentName(item.source)}</span>
            <span className="text-faint">{timeAgo(item.createdAt)}</span>
          </div>
          <a href={href(`/handoffs/${item.id}`)} className="mt-1 block text-[19px] font-semibold leading-snug tracking-[-0.015em] hover:underline hover:decoration-border-strong hover:underline-offset-4">
            {item.title || item.task}
          </a>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[12.5px] text-muted-foreground">{item.task}</span>
            <RepoLine item={item} />
          </div>
        </div>
        <div className="w-full sm:w-auto sm:shrink-0">
          <HandoffActions item={item} isLatestForTask getMarkdown={getMarkdown} getCompactMarkdown={getCompact} />
        </div>
      </div>
      <div className="border-t border-border bg-subtle px-5 py-4">
        <div className="flex items-start gap-3">
          <ArrowRight className="mt-0.5 size-4 shrink-0 text-faint" />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-muted-foreground">Next action</div>
            <p className="mt-0.5 text-[14px] leading-6">
              <InlineText text={item.nextAction} />
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-7">
          <PhaseBadge phase={item.phase} />
          <ChecksBadge checks={item.checks} verification={item.verification} />
          {item.files.count > 0 && (
            <span className="text-[12px] text-muted-foreground">
              {plural(item.files.count, "file")} changed
              {item.files.additions + item.files.deletions > 0 && (
                <>
                  {" "}
                  <span className="font-mono text-good">+{compact(item.files.additions)}</span> <span className="font-mono text-bad">−{compact(item.files.deletions)}</span>
                </>
              )}
            </span>
          )}
          {item.plan.total > 0 && (
            <span className="text-[12px] text-muted-foreground">
              Plan {item.plan.completed}/{item.plan.total}
            </span>
          )}
          <span className="text-[12px] text-faint">~{compact(item.tokens)} tokens</span>
        </div>
      </div>
    </Card>
  );
}

function Stats({ handoffs, scoped, rangeKey }: { handoffs: HandoffListItem[]; scoped: HandoffListItem[]; rangeKey: RangeKey }) {
  const range = resolveRange(rangeKey, handoffs);
  const perDay = React.useMemo(() => {
    const starts = buckets(range);
    return starts.map((start, index) => scoped.filter((handoff) => Date.parse(handoff.createdAt) >= start && Date.parse(handoff.createdAt) < (starts[index + 1] ?? Infinity)).length);
  }, [scoped, range]);

  const previous = React.useMemo(() => {
    if (rangeKey === "all") return undefined;
    const span = range.end - range.start;
    return handoffs.filter((handoff) => {
      const time = Date.parse(handoff.createdAt);
      return time >= range.start - span && time < range.start;
    }).length;
  }, [handoffs, range, rangeKey]);

  // Local captures have no agent, so they never count as moving work between agents.
  const taskAgents = new Map<string, Set<string>>();
  for (const handoff of scoped) {
    const agents = taskAgents.get(handoff.task) || new Set<string>();
    if (handoff.source) agents.add(handoff.source);
    taskAgents.set(handoff.task, agents);
  }
  const relayed = Array.from(taskAgents.values()).filter((agents) => agents.size > 1).length;
  const tokens = scoped.reduce((sum, handoff) => sum + handoff.tokens, 0);
  const verified = scoped.filter((handoff) => handoff.verification !== "unknown");
  const passing = verified.filter((handoff) => handoff.verification === "passed").length;
  const delta = previous === undefined ? undefined : scoped.length - previous;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat label="Handoffs" value={String(scoped.length)} detail={delta === undefined ? "since your first capture" : delta === 0 ? "same as the period before" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} vs the period before`} trend={perDay} />
      <Stat label="Tasks" value={String(taskAgents.size)} detail={relayed ? `${relayed} switched agents` : "each stayed with one agent"} />
      <Stat label="Context carried" value={`~${compact(tokens)}`} detail={scoped.length ? `tokens, ~${compact(Math.round(tokens / scoped.length))} per handoff` : "tokens"} />
      <Stat label="Checks passing" value={verified.length ? percent(passing, verified.length) : "–"} detail={verified.length ? `of ${plural(verified.length, "verified handoff")}` : "no checks ran yet"} />
    </div>
  );
}

function Stat({ label, value, detail, trend }: { label: string; value: string; detail: string; trend?: number[] }) {
  return (
    <Card className="p-4">
      <div className="text-[12.5px] text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="text-[26px] font-semibold leading-none tracking-[-0.02em]">{value}</div>
        {trend && <Sparkline values={trend} className="hidden sm:block" />}
      </div>
      <div className="mt-2 truncate text-[12px] text-faint">{detail}</div>
    </Card>
  );
}

function NoData() {
  return <p className="py-10 text-center text-[13px] text-faint">No handoffs in this range. Pick a longer one above.</p>;
}

function Onboarding() {
  const { status } = useData();
  const copy = useCopy();
  const steps = [
    { title: "Work with any agent as usual", body: "Codex, Claude Code, Gemini CLI, or Antigravity. ContextPool reads their session logs; it never talks to them." },
    { title: "Hand off when you switch", body: "In the repo, run the command below. It captures the session and git state, and copies a handoff to your clipboard.", command: "ctxpool handoff" },
    { title: "Paste it into the next agent", body: "Or connect the agent over MCP and it can fetch the handoff itself. New handoffs show up here automatically." }
  ];
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-20 pt-12 sm:px-8">
      <div className="flex items-center gap-1.5">
        {AGENT_ORDER.map((agent) => (
          <AgentTile key={agent} source={agent} size={36} label />
        ))}
      </div>
      <h1 className="mt-6 text-[28px] font-semibold leading-tight tracking-[-0.025em]">Hand off your first session</h1>
      <p className="mt-2 max-w-[560px] text-[15px] leading-7 text-muted-foreground">ContextPool turns the session you just worked in into a short brief the next agent can act on: what was asked, the plan, which checks passed, what changed, and what to do next.</p>

      <ol className="mt-8 space-y-px overflow-hidden rounded-lg border border-border">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-4 bg-background p-5 [&+li]:border-t [&+li]:border-border">
            <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong text-[12px] font-medium text-muted-foreground">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[14px] font-medium">{step.title}</h2>
              <p className="mt-1 text-[13.5px] leading-6 text-muted-foreground">{step.body}</p>
              {step.command && (
                <button onClick={() => void copy(step.command!, "Command copied")} className="group mt-3 flex w-full items-center gap-2 rounded-md border border-border bg-subtle px-3 py-2 text-left font-mono text-[13px] hover:border-border-strong">
                  <Terminal className="size-4 text-faint" />
                  <span className="flex-1">{step.command}</span>
                  <span className="font-sans text-[12px] text-faint group-hover:text-muted-foreground">Copy</span>
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>

      {status && (
        <div className="mt-8">
          <h2 className="text-[13.5px] font-medium">Agents on this machine</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {AGENT_ORDER.map((agent) => (
              <li key={agent} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                <AgentLogo source={agent} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{AGENTS[agent].name}</div>
                  <div className="truncate font-mono text-[11.5px] text-faint">{AGENTS[agent].sessionsDir}</div>
                </div>
                <span className={status.agents[agent] ? "text-[12px] font-medium text-good" : "text-[12px] text-faint"}>{status.agents[agent] ? "Sessions found" : "Not found"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] text-muted-foreground">
            Want agents to fetch handoffs themselves? <a href="#/connect" className="font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground">Connect them over MCP</a>. Run <Code>ctxpool sessions</Code> to see which sessions a handoff would use.
          </p>
        </div>
      )}
    </div>
  );
}
