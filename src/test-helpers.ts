import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
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
export function isolateEnv(): { home: string; codexHome: string; claudeHome: string; geminiHome: string; antigravityHome: string } {
  const geminiCliHome = tempDir("gemini");
  const env = {
    home: tempDir("home"),
    codexHome: tempDir("codex"),
    claudeHome: tempDir("claude"),
    geminiHome: join(geminiCliHome, ".gemini"),
    antigravityHome: tempDir("antigravity")
  };
  process.env.CTXPOOL_HOME = env.home;
  process.env.CODEX_HOME = env.codexHome;
  process.env.CLAUDE_CONFIG_DIR = env.claudeHome;
  process.env.GEMINI_CLI_HOME = geminiCliHome;
  process.env.CTXPOOL_ANTIGRAVITY_DIR = env.antigravityHome;
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

type PbValue = number | boolean | string | Uint8Array;

/** Protobuf wire encoding: numbers and booleans become varints, strings and bytes are length-delimited, arrays repeat. */
export function pb(fields: Record<number, PbValue | PbValue[] | undefined>): Uint8Array {
  const out: number[] = [];
  const varint = (value: bigint) => {
    let rest = BigInt.asUintN(64, value);
    do {
      const byte = Number(rest & 0x7fn);
      rest >>= 7n;
      out.push(rest ? byte | 0x80 : byte);
    } while (rest);
  };
  for (const [key, raw] of Object.entries(fields)) {
    for (const value of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      if (typeof value === "number" || typeof value === "boolean") {
        varint(BigInt(Number(key) << 3));
        varint(BigInt(Number(value)));
      } else {
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
        varint(BigInt((Number(key) << 3) | 2));
        varint(BigInt(bytes.length));
        for (const byte of bytes) out.push(byte);
      }
    }
  }
  return Uint8Array.from(out);
}

type AgyStepOptions = { status?: number; tool?: string; args?: Record<string, unknown> };
type AgyStep = { type: number; status: number; bytes: Uint8Array };

/** A gemini_coder.Step: type (1), status (4), metadata (5: created_at, source, tool_call), plus its payload field. */
function agyStep(type: number, payload: Record<number, PbValue | PbValue[]>, options: AgyStepOptions = {}): AgyStep {
  const status = options.status ?? 3;
  const toolCall = options.tool ? pb({ 1: `call_${options.tool}`, 2: options.tool, 3: JSON.stringify(options.args || {}) }) : undefined;
  return { type, status, bytes: pb({ 1: type, 4: status, 5: pb({ 1: pb({ 1: 1791378872, 2: 576000000 }), 3: toolCall ? 2 : 4, 4: toolCall }), ...payload }) };
}

/** Newer agy builds run tools as generic steps whose result wraps the typed step in a google.protobuf.Any. */
function agyGeneric(tool: string, args: Record<string, unknown>, resultText: string, typed?: AgyStep, status?: number): AgyStep {
  const result = pb({ 1: resultText, 6: typed ? pb({ 1: "type.googleapis.com/gemini_coder.Step", 2: typed.bytes }) : undefined });
  const entries = Object.entries(args).map(([key, value]) => pb({ 1: key, 2: String(value) }));
  return agyStep(132, { 140: pb({ 1: entries, 2: result }) }, { tool, args, status });
}

// Rows in the shape Antigravity CLI (agy) writes to ~/.gemini/antigravity-cli/conversations/<id>.db, using the
// table layout and proto field numbers agy ships with.
export const antigravity = {
  STATUS: { done: 3, cleared: 5, canceled: 6, error: 7 },
  conversation: (home: string, id: string, workspace: string, steps: AgyStep[], options: { parentId?: string } = {}) => {
    const path = join(home, "conversations", `${id}.db`);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE \`trajectory_meta\` (\`trajectory_id\` text,\`cascade_id\` text,\`trajectory_type\` integer,\`source\` integer,PRIMARY KEY (\`trajectory_id\`));
      CREATE TABLE \`steps\` (\`idx\` integer,\`step_type\` integer NOT NULL DEFAULT 0,\`status\` integer NOT NULL DEFAULT 0,\`has_subtrajectory\` numeric NOT NULL DEFAULT false,\`metadata\` blob,\`error_details\` blob,\`permissions\` blob,\`task_details\` blob,\`render_info\` blob,\`step_payload\` blob,\`step_format\` integer NOT NULL DEFAULT 0,PRIMARY KEY (\`idx\`));
      CREATE TABLE \`trajectory_metadata_blob\` (\`id\` text DEFAULT "main",\`data\` blob,PRIMARY KEY (\`id\`));`);
    const workspaceUri = pathToFileURL(workspace).href;
    const metadata = pb({ 1: pb({ 1: workspaceUri, 2: workspaceUri, 4: "main" }), 5: options.parentId, 6: id, 7: workspaceUri, 18: "default-cli-project" });
    db.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)").run(`trajectory-${id}`, id);
    db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(metadata);
    const insert = db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)");
    steps.forEach((step, idx) => insert.run(idx, step.type, step.status, step.bytes));
    db.close();
    return path;
  },
  index: (home: string, rows: { id: string; title: string; workspace: string; parentId?: string }[]) => {
    mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(join(home, "conversation_summaries.db"));
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE \`conversation_summaries\` (\`conversation_id\` text,\`title\` text NOT NULL DEFAULT "",\`preview\` text NOT NULL DEFAULT "",\`step_count\` integer NOT NULL DEFAULT 0,\`last_modified_time\` datetime NOT NULL,\`workspace_uris\` text NOT NULL,\`status\` text NOT NULL DEFAULT "",\`source\` text NOT NULL DEFAULT "",\`project_id\` text NOT NULL DEFAULT "",\`agent_name\` text NOT NULL DEFAULT "",\`parent_conversation_id\` text NOT NULL DEFAULT "",\`nesting_depth\` integer NOT NULL DEFAULT 0,\`battle_id\` text NOT NULL DEFAULT "",\`winning_conversation_id\` text NOT NULL DEFAULT "",\`not_fully_idle\` numeric NOT NULL DEFAULT false,\`killed\` numeric NOT NULL DEFAULT false,\`last_user_input_time\` datetime NOT NULL,\`last_user_input_step_index\` integer NOT NULL DEFAULT -1,\`app_data_dir\` text NOT NULL DEFAULT "", raw_summary BLOB, group_id TEXT NOT NULL DEFAULT '',PRIMARY KEY (\`conversation_id\`));`);
    const insert = db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth, last_user_input_time) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const row of rows) {
      const time = "2026-10-19 10:00:00+00:00";
      insert.run(row.id, row.title, time, JSON.stringify([pathToFileURL(row.workspace).href]), row.parentId || "", row.parentId ? 1 : 0, time);
    }
    db.close();
  },
  userInput: (text: string, status?: number) => agyStep(14, status === 5 ? {} : { 19: pb({ 2: text, 3: [pb({ 1: text })] }) }, { status }),
  reply: (text: string, status?: number) => agyStep(15, status === 5 ? {} : { 20: pb({ 1: text, 8: text }) }, { status }),
  checkpoint: (summary: string) => agyStep(23, { 30: pb({ 1: 1, 5: summary }) }),
  systemMessage: (text: string) => agyStep(101, { 114: pb({ 1: text }) }),
  /** Older builds: a typed run_command step (28: command_line 23, exit_code 6, combined_output 21, command_id 13). */
  runCommand: (command: string, exitCode: number | undefined, output = "", options: { status?: number; commandId?: string } = {}) =>
    agyStep(
      21,
      options.status === 5 ? {} : { 28: pb({ 23: command, 2: "/repo", 6: exitCode, 21: pb({ 1: output }), 13: options.commandId }) },
      { tool: "run_command", args: { CommandLine: command, Cwd: "/repo", WaitMsBeforeAsync: 5000 }, status: options.status }
    ),
  /** A background command's later status report (37: command_id 1, exit_code 5, combined 9). */
  commandStatus: (commandId: string, exitCode: number, output = "") => agyStep(28, { 37: pb({ 1: commandId, 5: exitCode, 9: output }) }),
  /** Newer builds: run_command as a generic step. */
  genericCommand: (command: string, exitCode: number, output = "") =>
    agyGeneric(
      "run_command",
      { CommandLine: command, Cwd: "/repo", WaitMsBeforeAsync: 5000 },
      `\nThe command exited with code ${exitCode}.\nOutput:\n${output}`,
      agyStep(21, { 28: pb({ 23: command, 6: exitCode, 21: pb({ 1: output }) }) })
    ),
  cancelledCommand: (command: string) =>
    agyGeneric("run_command", { CommandLine: command, Cwd: "/repo" }, "Encountered error in step execution: context canceled", undefined, 6),
  edit: (tool: string, file: string, status?: number) => agyGeneric(tool, { TargetFile: file, Instruction: "Edit" }, "Edited", undefined, status),
  tool: (tool: string, args: Record<string, unknown>) => agyGeneric(tool, args, "ok")
};
