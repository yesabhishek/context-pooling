import * as React from "react";
import { Check, Copy, FolderOpen, Terminal } from "lucide-react";
import { AGENT_ORDER, AGENTS, CURSOR_LOGO } from "@/lib/agents";
import { MCP_SETUP } from "@/lib/continue";
import { useData } from "@/lib/data";
import { tildePath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentLogo } from "@/components/agent-logo";
import { Card, PageHeader } from "@/components/ui/misc";
import { useCopy } from "@/components/ui/toast";

const COMMANDS: { command: string; does: string }[] = [
  { command: "ctxpool handoff", does: "Capture the latest session in this repo and copy the handoff" },
  { command: "ctxpool handoff --from claude", does: "Pick the agent when several were active" },
  { command: "ctxpool sessions", does: "List the sessions a handoff could use" },
  { command: "ctxpool show <task>", does: "Print the latest handoff for a task" },
  { command: "ctxpool status", does: "Show where data lives and which agents were found" }
];

const MCP_TOOLS: { name: string; returns: string }[] = [
  { name: "get_latest_agent_context", returns: "The latest handoff plus a structured summary. Start here." },
  { name: "get_handoff_by_task", returns: "The latest handoff for a task" },
  { name: "get_task_status", returns: "Next action, blockers, and touched files" },
  { name: "list_tasks", returns: "Tasks with handoffs, newest first" },
  { name: "get_context_pack", returns: "A context pack as markdown or JSON" }
];

export function ConnectView() {
  const { status } = useData();
  const [selected, setSelected] = React.useState(MCP_SETUP[0].id);
  const setup = MCP_SETUP.find((entry) => entry.id === selected)!;

  return (
    <div className="mx-auto w-full max-w-[960px] px-4 pb-20 pt-8 sm:px-8">
      <PageHeader title="Connect agents" description="Let agents fetch handoffs and packs themselves over MCP, instead of you pasting them in. Every tool is read-only." />

      <Card>
        <div className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2" role="tablist" aria-label="Agent">
          {MCP_SETUP.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={selected === entry.id}
              onClick={() => setSelected(entry.id)}
              className={cn(
                "-mb-px inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-[13.5px] transition-colors",
                selected === entry.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {entry.agent ? <AgentLogo source={entry.agent} size={16} /> : <img src={CURSOR_LOGO} alt="" width={16} height={16} className="dark:invert" />}
              {entry.label}
            </button>
          ))}
        </div>
        <div className="p-4">
          <p className="mb-2 text-[13px] text-muted-foreground">{setup.note}</p>
          <CommandBlock text={setup.command} />
          <p className="mt-3 text-[13px] text-muted-foreground">
            Then ask the agent to <span className="text-foreground">“continue from the latest ContextPool handoff”</span>. It will call <code className="font-mono text-[12px]">get_latest_agent_context</code>.
          </p>
        </div>
      </Card>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-[13.5px] font-medium">Sessions on this machine</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">Where ContextPool looks for each agent’s session logs.</p>
          <ul className="mt-3 divide-y divide-border">
            {AGENT_ORDER.map((agent) => (
              <li key={agent} className="flex items-center gap-3 py-2.5">
                <AgentLogo source={agent} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{AGENTS[agent].name}</div>
                  <div className="truncate font-mono text-[11.5px] text-faint">{AGENTS[agent].sessionsDir}</div>
                </div>
                {status?.agents[agent] ? (
                  <span className="inline-flex items-center gap-1 text-[12px] font-medium text-good">
                    <Check className="size-3.5" strokeWidth={3} /> Found
                  </span>
                ) : (
                  <span className="text-[12px] text-faint">Not found</span>
                )}
              </li>
            ))}
          </ul>
          {status && (
            <div className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-[12.5px] text-muted-foreground">
              <FolderOpen className="mt-0.5 size-3.5 shrink-0 text-faint" />
              <div className="min-w-0">
                Handoffs are stored in
                <code className="block truncate font-mono text-[12px] text-foreground" title={status.home}>
                  {tildePath(status.home)}
                </code>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="text-[13.5px] font-medium">MCP tools</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">What a connected agent can read.</p>
          <ul className="mt-3 space-y-2.5">
            {MCP_TOOLS.map((tool) => (
              <li key={tool.name} className="text-[13px]">
                <code className="font-mono text-[12px] text-foreground">{tool.name}</code>
                <p className="text-muted-foreground">{tool.returns}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <h2 className="mb-3 mt-10 text-[15px] font-semibold tracking-[-0.01em]">From the terminal</h2>
      <Card>
        <ul className="divide-y divide-border">
          {COMMANDS.map((entry) => (
            <CommandRow key={entry.command} {...entry} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function CommandBlock({ text }: { text: string }) {
  const copy = useCopy();
  const multiline = text.includes("\n");
  return (
    <div className="group relative rounded-md border border-border bg-subtle">
      <pre className={cn("overflow-x-auto px-3 py-2.5 pr-20 text-[12.5px] leading-5", !multiline && "whitespace-pre")}>
        {!multiline && <span className="select-none text-faint">$ </span>}
        {text}
      </pre>
      <button onClick={() => void copy(text, "Copied")} className="absolute right-2 top-2 inline-flex h-6 items-center gap-1 rounded border border-border bg-background px-2 text-[12px] text-muted-foreground hover:text-foreground">
        <Copy className="size-3" /> Copy
      </button>
    </div>
  );
}

function CommandRow({ command, does }: { command: string; does: string }) {
  const copy = useCopy();
  return (
    <li>
      <button onClick={() => void copy(command, "Command copied")} className="group flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-hover">
        <Terminal className="size-4 shrink-0 text-faint" />
        <code className="shrink-0 font-mono text-[12.5px]">{command}</code>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{does}</span>
        <Copy className="size-3.5 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
      </button>
    </li>
  );
}
