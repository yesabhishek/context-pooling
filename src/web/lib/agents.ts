import type { SourceAgent } from "../../types";
import antigravityLogo from "../assets/agents/antigravity.svg";
import claudeLogo from "../assets/agents/claude.svg";
import codexLogo from "../assets/agents/codex.svg";
import cursorLogo from "../assets/agents/cursor.svg";
import geminiLogo from "../assets/agents/gemini.svg";

export type AgentInfo = {
  id: SourceAgent;
  name: string;
  maker: string;
  logo: string;
  /** CSS color for chart marks. Text never uses it. */
  color: string;
  sessionsDir: string;
};

export const AGENT_ORDER: SourceAgent[] = ["codex", "claude", "gemini", "antigravity"];

export const AGENTS: Record<SourceAgent, AgentInfo> = {
  codex: { id: "codex", name: "Codex", maker: "OpenAI", logo: codexLogo, color: "var(--agent-codex)", sessionsDir: "~/.codex/sessions" },
  claude: { id: "claude", name: "Claude Code", maker: "Anthropic", logo: claudeLogo, color: "var(--agent-claude)", sessionsDir: "~/.claude/projects" },
  gemini: { id: "gemini", name: "Gemini CLI", maker: "Google", logo: geminiLogo, color: "var(--agent-gemini)", sessionsDir: "~/.gemini/tmp" },
  antigravity: { id: "antigravity", name: "Antigravity", maker: "Google", logo: antigravityLogo, color: "var(--agent-antigravity)", sessionsDir: "~/.gemini/antigravity-cli" }
};

export const CURSOR_LOGO = cursorLogo;

export function agentName(source: SourceAgent | undefined): string {
  return source ? AGENTS[source]?.name || source : "Local capture";
}

export function agentColor(source: SourceAgent | undefined): string {
  return source ? AGENTS[source]?.color || "var(--agent-unknown)" : "var(--agent-unknown)";
}
