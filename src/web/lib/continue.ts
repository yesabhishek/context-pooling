import type { SourceAgent } from "../../types";
import { shellQuote } from "./format";

export type ContinueOption = { agent: SourceAgent; label: string; command: string };

/**
 * Shell commands that start the next agent with this handoff as its first prompt.
 * The latest handoff for a task is addressed by task name; older ones by id.
 */
export function continueOptions(handoff: { id: string; task: string }, isLatestForTask: boolean): ContinueOption[] {
  const show = isLatestForTask ? `ctxpool show ${shellQuote(handoff.task)}` : `ctxpool show --id ${shellQuote(handoff.id)}`;
  return [
    { agent: "claude", label: "Claude Code", command: `claude "$(${show})"` },
    { agent: "codex", label: "Codex", command: `codex "$(${show})"` },
    { agent: "gemini", label: "Gemini CLI", command: `gemini -i "$(${show})"` }
  ];
}

/** What to tell an agent that has the ContextPool MCP server connected. */
export function mcpPrompt(task: string): string {
  return `Use the contextpool MCP server: call get_handoff_by_task with task ${JSON.stringify(task)}, check the repo matches, then continue from its next action.`;
}

export const MCP_SETUP: { id: string; label: string; agent?: SourceAgent; command: string; note: string }[] = [
  { id: "claude", label: "Claude Code", agent: "claude", command: "claude mcp add contextpool -- npx -y ctxpool mcp start", note: "Run once in a terminal." },
  { id: "codex", label: "Codex", agent: "codex", command: "codex mcp add contextpool -- npx -y ctxpool mcp start", note: "Run once in a terminal." },
  { id: "gemini", label: "Gemini CLI", agent: "gemini", command: "gemini mcp add -s user contextpool npx -y ctxpool mcp start", note: "Adds it for every project." },
  {
    id: "cursor",
    label: "Cursor",
    command: JSON.stringify({ mcpServers: { contextpool: { command: "npx", args: ["-y", "ctxpool", "mcp", "start"] } } }, null, 2),
    note: "Add to ~/.cursor/mcp.json."
  }
];
