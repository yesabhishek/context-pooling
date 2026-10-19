import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ctxpool-${prefix}-`));
}

export function writeJsonl(path: string, records: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
  return path;
}

/** Point every store and agent directory at fresh temp folders so tests never read real sessions. */
export function isolateEnv(): { home: string; codexHome: string; claudeHome: string; geminiHome: string } {
  const geminiCliHome = tempDir("gemini");
  const env = { home: tempDir("home"), codexHome: tempDir("codex"), claudeHome: tempDir("claude"), geminiHome: join(geminiCliHome, ".gemini") };
  process.env.CTXPOOL_HOME = env.home;
  process.env.CODEX_HOME = env.codexHome;
  process.env.CLAUDE_CONFIG_DIR = env.claudeHome;
  process.env.GEMINI_CLI_HOME = geminiCliHome;
  return env;
}

export function gitRepo(): string {
  const repo = tempDir("repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ctxpool@example.test");
  git("config", "user.name", "ContextPool Test");
  git("config", "commit.gpgsign", "false");
  return repo;
}

export function commitAll(repo: string, message = "commit"): void {
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo, stdio: "ignore" });
}

// Records in the shape Claude Code writes to ~/.claude/projects/<project>/<session>.jsonl
export const claude = {
  user: (cwd: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    type: "user",
    sessionId: "claude-session",
    cwd,
    timestamp: "2026-10-19T10:00:00.000Z",
    message: { role: "user", content },
    ...extra
  }),
  assistant: (cwd: string, content: unknown[]) => ({
    type: "assistant",
    sessionId: "claude-session",
    cwd,
    timestamp: "2026-10-19T10:01:00.000Z",
    message: { role: "assistant", content }
  }),
  text: (text: string) => ({ type: "text", text }),
  toolUse: (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input }),
  toolResult: (id: string, content: string, isError = false) => ({ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) })
};

// Records in the shape current Codex builds write to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
export const codex = {
  meta: (id: string, cwd: string, extra: Record<string, unknown> = {}) => ({
    type: "session_meta",
    payload: { id, cwd, timestamp: "2026-10-19T10:00:00.000Z", thread_source: "user", source: "vscode", ...extra }
  }),
  item: (item: Record<string, unknown>) => ({ type: "event_msg", payload: { type: "item_completed", item } }),
  userMessage: (text: string) => codex.item({ type: "UserMessage", content: [{ type: "text", text }] }),
  agentMessage: (text: string) => codex.item({ type: "AgentMessage", content: [{ type: "Text", text }], phase: "final_answer" }),
  command: (command: string, exitCode: number, output = "") =>
    codex.item({ type: "CommandExecution", command: ["/bin/zsh", "-lc", command], exit_code: exitCode, status: exitCode === 0 ? "completed" : "failed", aggregated_output: output }),
  fileChange: (path: string) => codex.item({ type: "FileChange", changes: { [path]: { type: "update", unified_diff: "" } }, status: "completed" })
};

// Records in the shape Gemini CLI writes to ~/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl
export const gemini = {
  /** Creates tmp/<name> with the .project_root marker Gemini CLI writes, and returns its chats folder. */
  project: (geminiHome: string, root: string, name = "work") => {
    const dir = join(geminiHome, "tmp", name);
    mkdirSync(join(dir, "chats"), { recursive: true });
    writeFileSync(join(dir, ".project_root"), root);
    return join(dir, "chats");
  },
  meta: (sessionId: string, projectRoot: string, extra: Record<string, unknown> = {}) => ({
    sessionId,
    projectHash: createHash("sha256").update(projectRoot).digest("hex"),
    startTime: "2026-10-19T10:00:00.000Z",
    lastUpdated: "2026-10-19T10:00:00.000Z",
    kind: "main",
    ...extra
  }),
  user: (id: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    timestamp: "2026-10-19T10:00:00.000Z",
    type: "user",
    content: typeof content === "string" ? [{ text: content }] : content,
    ...extra
  }),
  reply: (id: string, text: string, toolCalls?: unknown[]) => ({
    id,
    timestamp: "2026-10-19T10:01:00.000Z",
    type: "gemini",
    content: text,
    thoughts: [{ subject: "Planning", description: "Thinking it through", timestamp: "2026-10-19T10:00:30.000Z" }],
    model: "gemini-3-pro-preview",
    ...(toolCalls ? { toolCalls } : {})
  }),
  tool: (id: string, name: string, args: Record<string, unknown>, output: string, status = "success") => ({
    id,
    name,
    args,
    result: [{ functionResponse: { id, name, response: { output } } }],
    status,
    timestamp: "2026-10-19T10:01:00.000Z",
    displayName: name,
    description: "",
    renderOutputAsMarkdown: false
  }),
  /** The shell tool reports stdout after "Output: " and appends "Exit Code: N" only when N is non-zero. */
  shell: (id: string, command: string, exitCode: number, output = "") =>
    gemini.tool(id, "run_shell_command", { command }, [`Output: ${output || "(empty)"}`, ...(exitCode ? [`Exit Code: ${exitCode}`] : []), "Process Group PGID: 4242"].join("\n"))
};
