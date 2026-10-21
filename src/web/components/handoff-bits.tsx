import * as React from "react";
import { Check, ChevronDown, CircleDashed, Copy, Download, FileText, GitBranch, Plug, X } from "lucide-react";
import type { HandoffListItem, VerificationStatus, WorkPhase } from "../../types";
import { continueOptions, mcpPrompt } from "@/lib/continue";
import { cn } from "@/lib/utils";
import { AgentLogo } from "@/components/agent-logo";
import { Badge } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { useCopy } from "@/components/ui/toast";

const PHASES: Record<WorkPhase, { label: string; tone: "neutral" | "good" | "bad" | "warn" }> = {
  planning: { label: "Planning", tone: "neutral" },
  implementation: { label: "Implementing", tone: "neutral" },
  debugging: { label: "Debugging", tone: "warn" },
  verification: { label: "Verifying", tone: "neutral" },
  review: { label: "Ready for review", tone: "good" },
  blocked: { label: "Blocked", tone: "bad" },
  handoff: { label: "Handed off", tone: "neutral" }
};

export function phaseLabel(phase: WorkPhase): string {
  return PHASES[phase]?.label || phase;
}

export function PhaseBadge({ phase }: { phase: WorkPhase }) {
  const info = PHASES[phase] || { label: phase, tone: "neutral" as const };
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

export function ChecksBadge({ checks, verification }: { checks: HandoffListItem["checks"]; verification: VerificationStatus }) {
  if (checks.failed) {
    return (
      <Badge tone="bad">
        <X strokeWidth={3} />
        {checks.failed} failing
      </Badge>
    );
  }
  if (checks.passed || verification === "passed") {
    return (
      <Badge tone="good">
        <Check strokeWidth={3} />
        {checks.passed || ""} passing
      </Badge>
    );
  }
  return (
    <Badge tone="outline">
      <CircleDashed />
      Not verified
    </Badge>
  );
}

export function VerificationIcon({ status, className }: { status: VerificationStatus; className?: string }) {
  if (status === "passed") return <Check aria-label="Passed" strokeWidth={2.75} className={cn("size-4 shrink-0 text-good", className)} />;
  if (status === "failed") return <X aria-label="Failed" strokeWidth={2.75} className={cn("size-4 shrink-0 text-bad", className)} />;
  return <CircleDashed aria-label="No exit code" className={cn("size-4 shrink-0 text-faint", className)} />;
}

/** repo, branch @ commit — the git anchor the next agent should check against. */
export function RepoLine({ item, className }: { item: Pick<HandoffListItem, "repoName" | "branch" | "commit" | "isGitRepo">; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground", className)}>
      <span className="truncate">{item.repoName}</span>
      {item.isGitRepo ? (
        <>
          <GitBranch className="size-3.5 shrink-0 text-faint" />
          <span className="truncate font-mono text-[12px]">{item.branch}</span>
          <span className="shrink-0 font-mono text-[12px] text-faint">{item.commit.slice(0, 7)}</span>
        </>
      ) : (
        <span className="shrink-0 text-faint">no git</span>
      )}
    </span>
  );
}

/**
 * The primary actions on a handoff: copy it, or start the next agent with it.
 * `getMarkdown` is called ahead of time so the copy happens inside the click.
 */
export function HandoffActions({ item, isLatestForTask, getMarkdown, getCompactMarkdown, size = "md" }: { item: HandoffListItem; isLatestForTask: boolean; getMarkdown: () => Promise<string>; getCompactMarkdown?: () => Promise<string>; size?: "sm" | "md" }) {
  const copy = useCopy();
  const [markdown, setMarkdown] = React.useState<string>();
  React.useEffect(() => {
    let live = true;
    setMarkdown(undefined);
    getMarkdown().then((text) => live && setMarkdown(text), () => undefined);
    return () => {
      live = false;
    };
  }, [getMarkdown]);

  const copyMarkdown = async () => copy(markdown ?? (await getMarkdown()), "Handoff copied. Paste it into the next agent.");
  const download = async () => {
    const blob = new Blob([markdown ?? (await getMarkdown())], { type: "text/markdown" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${item.task.replace(/[^\w.-]+/g, "-")}-handoff.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="primary" size={size} onClick={() => void copyMarkdown()}>
        <Copy /> Copy handoff
      </Button>
      <Menu
        className="w-[300px]"
        trigger={({ toggle, open, ref }) => (
          <Button ref={ref} variant="secondary" size={size} onClick={toggle} aria-expanded={open} aria-haspopup="menu">
            Continue in <ChevronDown className="text-faint" />
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuLabel>Start a new session with this handoff</MenuLabel>
            {continueOptions(item, isLatestForTask).map((option) => (
              <MenuItem
                key={option.agent}
                icon={<AgentLogo source={option.agent} size={16} />}
                hint="Copy command"
                onSelect={() => {
                  close();
                  void copy(option.command, `Copied. Run it in your terminal to start ${option.label}.`);
                }}
              >
                {option.label}
              </MenuItem>
            ))}
            {isLatestForTask && (
              <MenuItem
                icon={<Plug />}
                hint="Copy prompt"
                onSelect={() => {
                  close();
                  void copy(mcpPrompt(item.task), "Prompt copied for an MCP-connected agent");
                }}
              >
                Any agent over MCP
              </MenuItem>
            )}
            <MenuSeparator />
            {getCompactMarkdown && (
              <MenuItem
                icon={<FileText />}
                onSelect={() => {
                  close();
                  void getCompactMarkdown().then((text) => copy(text, "Copied without the transcript"));
                }}
              >
                Copy without transcript
              </MenuItem>
            )}
            <MenuItem
              icon={<Download />}
              onSelect={() => {
                close();
                void download();
              }}
            >
              Download .md
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}
