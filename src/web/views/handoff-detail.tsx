import * as React from "react";
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, Circle, CircleCheck, CircleDot, Copy, Download, ExternalLink, FileCode2, Layers, Search, TerminalSquare, User } from "lucide-react";
import type { FileChange, HandoffContinuitySummary, HandoffPacket, PlanItem, SourceAgent, TranscriptEntry } from "../../types";
import { fetchFileView, fetchHandoff, openInEditor, type FileView } from "@/lib/api";
import { agentName } from "@/lib/agents";
import { useData } from "@/lib/data";
import { compact, fullDate, plural, splitPath, timeAgo, tildePath } from "@/lib/format";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AgentLogo, AgentTile } from "@/components/agent-logo";
import { AddToPackDialog } from "@/components/add-to-pack";
import { DiffBlocks, DiffCount, Meter } from "@/components/charts/bars";
import { SessionStrip } from "@/components/charts/session-strip";
import { ChecksBadge, HandoffActions, PhaseBadge, RepoLine, VerificationIcon } from "@/components/handoff-bits";
import { InlineText } from "@/components/inline-text";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Card, Code, EmptyState, Spinner } from "@/components/ui/misc";
import { useCopy, useToast } from "@/components/ui/toast";

type Tab = "overview" | "changes" | "session" | "markdown";

export function HandoffDetailView({ id, tab }: { id: string; tab: string }) {
  const { handoffs } = useData();
  const [packet, setPacket] = React.useState<HandoffPacket>();
  const [error, setError] = React.useState<string>();
  const [packOpen, setPackOpen] = React.useState(false);
  const item = handoffs.find((handoff) => handoff.id === id);
  const isLatestForTask = Boolean(item && handoffs.find((handoff) => handoff.task === item.task)?.id === id);

  React.useEffect(() => {
    let live = true;
    fetchHandoff(id).then(
      (next) => live && setPacket(next),
      (fetchError: unknown) => live && setError(fetchError instanceof Error ? fetchError.message : "Could not load this handoff")
    );
    return () => {
      live = false;
    };
  }, [id]);

  const getMarkdown = React.useCallback(async () => packet?.markdown ?? (await fetchHandoff(id)).markdown, [packet, id]);
  const getCompact = React.useCallback(() => fetch(`/api/handoffs/${encodeURIComponent(id)}/agent-context`).then((response) => response.text()), [id]);

  if (error) {
    return (
      <div className="mx-auto max-w-[1160px] px-4 pt-8 sm:px-8">
        <BackLink />
        <EmptyState icon={<AlertTriangle />} title="Handoff not found" action={<Button variant="secondary" onClick={() => navigate("/handoffs")}>See all handoffs</Button>}>
          It may have been captured in another ContextPool store, or the link is out of date.
        </EmptyState>
      </div>
    );
  }
  if (!packet || !item) {
    return (
      <div className="grid h-60 place-items-center">
        <Spinner />
      </div>
    );
  }

  const summary = packet.handoffSummary!;
  const session = packet.sourceSession;
  const activeTab = (["overview", "changes", "session", "markdown"].includes(tab) ? tab : "overview") as Tab;
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "changes", label: "Changes", count: summary.fileChanges.length },
    { key: "session", label: "Transcript", count: session?.transcript.length },
    { key: "markdown", label: "Handoff file" }
  ];

  return (
    <div className="mx-auto w-full max-w-[1160px] px-4 pb-24 pt-6 sm:px-8">
      <BackLink task={item.task} />

      <header className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-4">
          <AgentTile source={item.source} size={48} label />
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{item.title || item.task}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
              <span>
                <span className="font-medium text-foreground">{agentName(item.source)}</span> session
              </span>
              <a href={href("/handoffs", { task: item.task })} className="hover:text-foreground hover:underline hover:underline-offset-4">
                {item.task}
              </a>
              <RepoLine item={item} />
              <span title={fullDate(item.createdAt)}>{timeAgo(item.createdAt)}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setPackOpen(true)}>
            <Layers className="text-faint" /> Add to pack
          </Button>
          <HandoffActions item={item} isLatestForTask={isLatestForTask} getMarkdown={getMarkdown} getCompactMarkdown={getCompact} />
        </div>
      </header>

      {!isLatestForTask && (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-border bg-subtle px-3 py-2 text-[13px] text-muted-foreground">
          <AlertTriangle className="size-4 shrink-0 text-warn" />
          <span>
            There’s a newer handoff for <span className="font-medium text-foreground">{item.task}</span>.
          </span>
          <a href={href(`/handoffs/${handoffs.find((handoff) => handoff.task === item.task)!.id}`)} className="ml-auto shrink-0 font-medium text-foreground hover:underline hover:underline-offset-4">
            Open latest
          </a>
        </div>
      )}

      <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]" aria-label="Handoff sections">
        {tabs.map((entry) => (
          <a
            key={entry.key}
            href={href(`/handoffs/${id}`, { tab: entry.key === "overview" ? undefined : entry.key })}
            aria-current={activeTab === entry.key ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13.5px] transition-colors",
              activeTab === entry.key ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {entry.label}
            {entry.count !== undefined && <span className="tabular rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{entry.count}</span>}
          </a>
        ))}
      </nav>

      <div className="mt-6">
        {activeTab === "overview" && <OverviewTab packet={packet} summary={summary} />}
        {activeTab === "changes" && <ChangesTab packet={packet} changes={summary.fileChanges} />}
        {activeTab === "session" && <TranscriptTab packet={packet} />}
        {activeTab === "markdown" && <MarkdownTab packet={packet} />}
      </div>

      <AddToPackDialog open={packOpen} onClose={() => setPackOpen(false)} handoff={item} />
    </div>
  );
}

function BackLink({ task }: { task?: string }) {
  return (
    <a href={task ? href("/handoffs", { task }) : "#/handoffs"} className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
      <ChevronLeft className="size-4" /> {task ? task : "Handoffs"}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Overview

function OverviewTab({ packet, summary }: { packet: HandoffPacket; summary: HandoffContinuitySummary }) {
  const session = packet.sourceSession;
  const plan = summary.plan || [];
  const commands = session?.commands || [];
  const edits = session?.edits || [];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-8">
        <section className="rounded-lg border border-border bg-subtle p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-ink text-ink-foreground">
              <ArrowRight className="size-3.5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[12.5px] font-medium text-muted-foreground">Next action</h2>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-6">
                <InlineText text={summary.nextAction} />
              </p>
            </div>
          </div>
        </section>

        <Section title="Objective">
          <LongText text={summary.originalQuestion} />
        </Section>
        {summary.latestUserInstruction && summary.latestUserInstruction !== summary.originalQuestion && (
          <Section title="Latest request">
            <LongText text={summary.latestUserInstruction} />
          </Section>
        )}
        {summary.latestAssistantSummary && (
          <Section title={`Last update from ${agentName(session?.source)}`}>
            <LongText text={summary.latestAssistantSummary} muted />
          </Section>
        )}

        {plan.length > 0 ? (
          <Section title="Plan" aside={`${plan.filter((step) => step.status === "completed").length} of ${plan.length} done`}>
            <Meter value={plan.filter((step) => step.status === "completed").length} partial={plan.filter((step) => step.status === "in_progress").length} total={plan.length} className="mb-3" />
            <ul className="space-y-1.5">
              {plan.map((step, index) => (
                <PlanStep key={index} step={step} />
              ))}
            </ul>
          </Section>
        ) : (
          summary.agentPlan && (
            <Section title="Plan">
              <LongText text={summary.agentPlan} muted />
            </Section>
          )
        )}

        <Section title="Checks" aside={<ChecksBadge checks={checkCounts(summary)} verification={summary.verification.status} />}>
          {summary.verification.commands.length ? (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {summary.verification.commands.map((command, index) => (
                <li key={index} className="flex items-start gap-3 px-3 py-2.5">
                  <VerificationIcon status={command.status} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <code className="break-all font-mono text-[12.5px]">{command.command}</code>
                    {command.evidence && <p className={cn("mt-0.5 break-words text-[12.5px]", command.status === "failed" ? "text-bad" : "text-muted-foreground")}>{command.evidence}</p>}
                  </div>
                  {command.exitCode !== undefined && <span className="shrink-0 font-mono text-[11.5px] text-faint">exit {command.exitCode}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-muted-foreground">No tests, type checks, or builds ran in this session.</p>
          )}
          {summary.verification.gaps.length > 0 && (
            <ul className="mt-2 space-y-1">
              {summary.verification.gaps.map((gap) => (
                <li key={gap} className="flex items-start gap-2 text-[13px] text-warn">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {gap}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Bullets title="Blockers" items={summary.blockers} tone="bad" />
        {!summary.verification.commands.length && <Bullets title="Errors" items={summary.errors} tone="bad" />}
        <Bullets title="Decisions" items={summary.decisions} />
        <Bullets title="Constraints" items={summary.constraints || []} />
        {session?.compactSummary && (
          <Section title="Earlier context" aside="From the agent’s compaction summary">
            <LongText text={session.compactSummary} muted />
          </Section>
        )}
        {session?.links?.length ? <Bullets title="Links" items={session.links} /> : null}
      </div>

      <aside className="min-w-0 space-y-4">
        <Details packet={packet} summary={summary} />
        {commands.length + edits.length > 1 && (
          <Card className="p-4">
            <h2 className="text-[13px] font-medium">Session activity</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {plural(edits.length, "edit")} and {plural(commands.length, "command")}, in order. The rule marks the last edit.
            </p>
            <div className="mt-3">
              <SessionStrip commands={commands} edits={edits} checks={summary.verification.commands} />
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
              <li className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full bg-good" /> passed
              </li>
              <li className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full bg-bad" /> failed
              </li>
              <li className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full border-[1.5px] border-faint" /> no exit code
              </li>
              <li className="inline-flex items-center gap-1">
                <span className="h-2.5 w-0.5 rounded-full bg-muted-foreground/60" /> edit
              </li>
            </ul>
          </Card>
        )}
      </aside>
    </div>
  );
}

function checkCounts(summary: HandoffContinuitySummary) {
  const commands = summary.verification.commands;
  return {
    passed: commands.filter((command) => command.status === "passed").length,
    failed: commands.filter((command) => command.status === "failed").length,
    unknown: commands.filter((command) => command.status === "unknown").length
  };
}

function Details({ packet, summary }: { packet: HandoffPacket; summary: HandoffContinuitySummary }) {
  const copy = useCopy();
  const session = summary.sourceSession;
  const rows: [string, React.ReactNode][] = [
    [
      "Agent",
      <span className="inline-flex items-center gap-1.5">
        <AgentLogo source={session?.source} size={14} /> {agentName(session?.source)}
      </span>
    ],
    ["Phase", <PhaseBadge phase={summary.workPhase} />],
    ["Captured", <span title={packet.createdAt}>{fullDate(packet.createdAt)}</span>],
    ...(session
      ? ([
          [
            "Session",
            <button onClick={() => void copy(session.id, "Session id copied")} className="group inline-flex max-w-full items-center gap-1 font-mono text-[12px] hover:text-foreground" title="Copy session id">
              <span className="truncate">{session.id}</span>
              <Copy className="size-3 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
            </button>
          ],
          ["Transcript", plural(session.transcriptItems, "entry", "entries")]
        ] as [string, React.ReactNode][])
      : []),
    [
      "Repository",
      <button onClick={() => void copy(packet.repo.repoPath, "Path copied")} className="block max-w-full truncate text-left font-mono text-[12px] hover:text-foreground" title={`${packet.repo.repoPath} (click to copy)`} dir="rtl">
        <bdi>{tildePath(packet.repo.repoPath)}</bdi>
      </button>
    ],
    ...(packet.repo.isGitRepo
      ? ([
          ["Branch", <span className="break-all font-mono text-[12px]">{packet.repo.branch}</span>],
          [
            "Commit",
            <button onClick={() => void copy(packet.repo.commit, "Commit copied")} className="font-mono text-[12px] hover:text-foreground" title="Copy commit">
              {packet.repo.commit}
            </button>
          ]
        ] as [string, React.ReactNode][])
      : ([["Git", "Not a git repository"]] as [string, React.ReactNode][])),
    ...(packet.targetAgent ? ([["For", packet.targetAgent]] as [string, React.ReactNode][]) : []),
    ["Size", `~${compact(packet.tokenEstimate ?? Math.ceil(packet.markdown.length / 4))} tokens`]
  ];
  return (
    <Card className="p-4">
      <h2 className="text-[13px] font-medium">Details</h2>
      <dl className="mt-3 space-y-2.5">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-2 text-[13px]">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function PlanStep({ step }: { step: PlanItem }) {
  const Icon = step.status === "completed" ? CircleCheck : step.status === "in_progress" ? CircleDot : Circle;
  return (
    <li className="flex items-start gap-2.5 text-[14px] leading-6">
      <Icon className={cn("mt-1 size-4 shrink-0", step.status === "completed" ? "text-good" : step.status === "in_progress" ? "text-foreground" : "text-faint")} />
      <span className={cn(step.status === "completed" && "text-muted-foreground", step.status === "in_progress" && "font-medium")}>
        <InlineText text={step.text} />
      </span>
      {step.status === "in_progress" && <Badge className="mt-0.5">In progress</Badge>}
    </li>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h2>
        {aside && <div className="shrink-0 text-[12.5px] text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function Bullets({ title, items, tone }: { title: string; items: string[]; tone?: "bad" }) {
  if (!items.length) return null;
  return (
    <Section title={title}>
      <ul className="space-y-1.5">
        {items.map((entry, index) => (
          <li key={index} className="flex gap-2.5 text-[14px] leading-6">
            <span className={cn("mt-[11px] size-1 shrink-0 rounded-full", tone === "bad" ? "bg-bad" : "bg-faint")} />
            <span className="min-w-0 break-words">
              <InlineText text={entry} />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function LongText({ text, muted }: { text: string; muted?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const long = text.length > 700 || text.split("\n").length > 10;
  return (
    <div>
      <p className={cn("whitespace-pre-wrap break-words text-[14px] leading-6", muted && "text-muted-foreground", long && !expanded && "line-clamp-[8]")}>{text}</p>
      {long && (
        <button onClick={() => setExpanded(!expanded)} className="mt-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes

const STATUS_LETTER: Record<FileChange["status"], { letter: string; label: string; className: string }> = {
  added: { letter: "A", label: "Added", className: "text-good" },
  untracked: { letter: "U", label: "Untracked", className: "text-good" },
  modified: { letter: "M", label: "Modified", className: "text-warn" },
  deleted: { letter: "D", label: "Deleted", className: "text-bad" },
  renamed: { letter: "R", label: "Renamed", className: "text-accent" },
  copied: { letter: "C", label: "Copied", className: "text-accent" },
  unknown: { letter: "?", label: "Changed", className: "text-faint" }
};

function ChangesTab({ packet, changes }: { packet: HandoffPacket; changes: FileChange[] }) {
  const [open, setOpen] = React.useState<string>();
  const additions = changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
  if (!changes.length) {
    return <EmptyState icon={<FileCode2 />} title="No uncommitted changes">The working tree was clean when this handoff was captured.</EmptyState>;
  }
  const byStatus = Object.entries(
    changes.reduce<Record<string, number>>((counts, change) => ({ ...counts, [STATUS_LETTER[change.status].label]: (counts[STATUS_LETTER[change.status].label] || 0) + 1 }), {})
  );
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{plural(changes.length, "file")}</span> changed at capture
        </span>
        {additions + deletions > 0 && <DiffCount additions={additions} deletions={deletions} className="text-[13px]" />}
        <span className="text-faint">{byStatus.map(([label, count]) => `${count} ${label.toLowerCase()}`).join(", ")}</span>
        {packet.repo.diffPatchTruncated && <span className="text-warn">The stored diff was truncated.</span>}
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {changes.map((change) => (
          <FileRow key={change.path} change={change} repoPath={packet.repo.repoPath} open={open === change.path} onToggle={() => setOpen(open === change.path ? undefined : change.path)} />
        ))}
      </ul>
    </div>
  );
}

function FileRow({ change, repoPath, open, onToggle }: { change: FileChange; repoPath: string; open: boolean; onToggle: () => void }) {
  const notify = useToast();
  const status = STATUS_LETTER[change.status];
  const { dir, name } = splitPath(change.path);
  return (
    <li>
      <div className="flex items-center gap-3 px-3 py-2 hover:bg-hover">
        <span title={status.label} className={cn("w-3 shrink-0 text-center font-mono text-[12px] font-semibold", status.className)}>
          {status.letter}
        </span>
        <button onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[12.5px]" title={change.path}>
          <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
          <span className="min-w-0 truncate">
          {change.oldPath && <span className="text-faint">{change.oldPath} → </span>}
          <span className="text-faint">{dir}</span>
          <span className="text-foreground">{name}</span>
          </span>
        </button>
        <span className="hidden shrink-0 sm:inline-flex">
          <DiffBlocks additions={change.additions} deletions={change.deletions} />
        </span>
        {change.additions + change.deletions > 0 ? <DiffCount additions={change.additions} deletions={change.deletions} className="w-[84px] shrink-0 justify-end" /> : <span className="w-[84px] shrink-0 text-right text-[12px] text-faint">{STATUS_LETTER[change.status].label}</span>}
        <IconButton
          label="Open in editor"
          size="icon-sm"
          onClick={() =>
            void openInEditor(repoPath, change.path).then(
              (result) => notify(result.ok ? `Opened with ${result.method}` : result.error || "Couldn’t open the file"),
              (openError: unknown) => notify(openError instanceof Error ? openError.message : "Couldn’t open the file")
            )
          }
        >
          <ExternalLink />
        </IconButton>
      </div>
      {open && <FilePreview change={change} repoPath={repoPath} />}
    </li>
  );
}

function FilePreview({ change, repoPath }: { change: FileChange; repoPath: string }) {
  const [view, setView] = React.useState<FileView>();
  React.useEffect(() => {
    if (change.diff) return;
    let live = true;
    fetchFileView(repoPath, change.path).then((next) => live && setView(next), () => live && setView({ ok: false, error: "Couldn’t load the file" }));
    return () => {
      live = false;
    };
  }, [change, repoPath]);

  if (change.diff) return <DiffView diff={change.diff} />;
  if (!view) return <div className="border-t border-border px-4 py-3 text-[12.5px] text-faint">Loading…</div>;
  if (!view.ok) return <div className="border-t border-border px-4 py-3 text-[12.5px] text-muted-foreground">{view.error}</div>;
  return (
    <div className="border-t border-border bg-subtle">
      <div className="px-4 pt-2 text-[11.5px] text-faint">Current file on disk{view.redacted ? ", with secrets redacted" : ""}. No diff was stored for it.</div>
      <pre className="max-h-[420px] overflow-auto px-4 py-2 text-[12px] leading-5">{view.content}</pre>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n").filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line));
  return (
    <pre className="max-h-[480px] overflow-auto border-t border-border bg-subtle py-1 text-[12px] leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "px-4",
            line.startsWith("+") && "bg-good/10 text-foreground",
            line.startsWith("-") && "bg-bad/10 text-foreground",
            line.startsWith("@@") && "text-accent",
            !/^[+\-@]/.test(line) && "text-muted-foreground"
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Transcript

const PAGE = 120;

function TranscriptTab({ packet }: { packet: HandoffPacket }) {
  const session = packet.sourceSession;
  const [role, setRole] = React.useState<"all" | TranscriptEntry["role"]>("all");
  const [query, setQuery] = React.useState("");
  const [shown, setShown] = React.useState(PAGE);
  const entries = React.useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (session?.transcript || []).filter((entry) => (role === "all" || entry.role === role) && words.every((word) => entry.text.toLowerCase().includes(word)));
  }, [session, role, query]);

  if (!session?.transcript.length) {
    return <EmptyState icon={<TerminalSquare />} title="No transcript">This handoff was captured without a source session.</EmptyState>;
  }
  const visible = entries.slice(-shown);
  return (
    <div className="max-w-[860px]">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-faint" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the transcript" aria-label="Search the transcript" className="pl-8" />
        </div>
        <div role="radiogroup" aria-label="Who" className="flex h-8 items-center rounded-md border border-border-strong p-0.5">
          {(["all", "user", "assistant", "tool"] as const).map((value) => (
            <button
              key={value}
              role="radio"
              aria-checked={role === value}
              onClick={() => setRole(value)}
              className={cn("h-full rounded-[5px] px-2.5 text-[12.5px] font-medium", role === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {value === "all" ? "All" : value === "user" ? "You" : value === "assistant" ? agentName(session.source) : "Tools"}
            </button>
          ))}
        </div>
        <span className="text-[12.5px] text-faint">{plural(entries.length, "entry", "entries")}</span>
      </div>
      {entries.length > shown && (
        <button onClick={() => setShown(shown + PAGE)} className="mb-4 w-full rounded-md border border-dashed border-border-strong py-2 text-[12.5px] text-muted-foreground hover:text-foreground">
          Show {Math.min(PAGE, entries.length - shown)} earlier
        </button>
      )}
      <ol className="space-y-5">
        {visible.map((entry, index) => (
          <TranscriptItem key={`${entries.length - visible.length + index}`} entry={entry} source={session.source} />
        ))}
      </ol>
      {!entries.length && <p className="py-10 text-center text-[13px] text-faint">Nothing in the transcript matches.</p>}
    </div>
  );
}

function TranscriptItem({ entry, source }: { entry: TranscriptEntry; source: SourceAgent }) {
  const [expanded, setExpanded] = React.useState(false);
  const tool = entry.role === "tool" || entry.role === "system";
  const long = entry.text.length > 900;
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background">
        {entry.role === "user" ? <User className="size-3.5 text-muted-foreground" /> : entry.role === "assistant" ? <AgentLogo source={source} size={13} /> : <TerminalSquare className="size-3.5 text-faint" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[12.5px]">
          <span className="font-medium">{entry.role === "user" ? "You" : entry.role === "assistant" ? agentName(source) : entry.kind || "Tool"}</span>
          {entry.timestamp && <span className="text-faint">{new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}
        </div>
        <div
          className={cn(
            "mt-1 whitespace-pre-wrap break-words",
            tool ? "rounded-md border border-border bg-subtle px-3 py-2 font-mono text-[12px] leading-5 text-muted-foreground" : "text-[14px] leading-6",
            (tool || long) && !expanded && "line-clamp-6"
          )}
        >
          {entry.text}
        </div>
        {(tool ? entry.text.split("\n").length > 6 || entry.text.length > 500 : long) && (
          <button onClick={() => setExpanded(!expanded)} className="mt-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
            {expanded ? "Show less" : "Show all"}
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Markdown

function MarkdownTab({ packet }: { packet: HandoffPacket }) {
  const copy = useCopy();
  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([packet.markdown], { type: "text/markdown" }));
    link.download = `${packet.task.replace(/[^\w.-]+/g, "-")}-handoff.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <div className="max-w-[860px]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="mr-auto text-[13px] text-muted-foreground">
          This is exactly what <Code>ctxpool handoff</Code> copied. ~{compact(packet.tokenEstimate ?? Math.ceil(packet.markdown.length / 4))} tokens.
          {packet.markdownPath && <span className="block truncate font-mono text-[11.5px] text-faint">{tildePath(packet.markdownPath)}</span>}
        </p>
        <Button variant="secondary" size="sm" onClick={download}>
          <Download /> Download
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void copy(packet.markdown, "Handoff copied")}>
          <Copy /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-subtle p-4 text-[12.5px] leading-6">{packet.markdown}</pre>
    </div>
  );
}
