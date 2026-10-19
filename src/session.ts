import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CommandRun, FileEdit, PlanItem, PlanStatus, SourceAgent, SourceSession, TranscriptEntry } from "./types.js";
import { oneLine, truncate } from "./text.js";
import { CtxError, canonicalPath, findRecentFiles, unique } from "./util.js";
import { commandStatus } from "./verify.js";

export type SessionFrom = "auto" | SourceAgent;

export type ResolveSessionOptions = {
  from?: SessionFrom;
  cwd: string;
  /** Git top-level of `cwd`; sessions started anywhere inside it count as this workspace. */
  repoRoot?: string;
  session?: string;
  /** Token budget for the transcript excerpt. */
  budget?: number;
};

export type SessionCandidate = {
  source: SourceAgent;
  path: string;
  id: string;
  cwd?: string;
  updatedAt: string;
  matchedCwd: boolean;
  title?: string;
};

type Scope = { cwd: string; repoRoot?: string };

const DEFAULT_EXCERPT_TOKENS = 3_000;
const AMBIGUITY_WINDOW_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 200;

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function sourceLabel(source: SourceAgent): string {
  return source === "claude" ? "Claude" : "Codex";
}

export function resolveSessionSource(options: ResolveSessionOptions): SourceSession {
  const from = normalizeFrom(options.from || "auto");
  const scope = toScope(options.cwd, options.repoRoot);

  if (options.session) return resolveExplicitSession(from, scope, options.session, options.budget);

  const [first, second] = listSessionCandidates({ ...scope, from }).filter((candidate) => candidate.matchedCwd);
  if (!first) {
    const label = from === "auto" ? "Codex or Claude" : sourceLabel(from);
    throw new CtxError(`No ${label} session found for ${scope.cwd}.`, "Run `ctxpool sessions --all` to list sessions, then pass --session <id or path>.");
  }
  if (from === "auto" && second && second.source !== first.source && Date.parse(first.updatedAt) - Date.parse(second.updatedAt) < AMBIGUITY_WINDOW_MS) {
    throw new CtxError(
      "Codex and Claude were both active in this workspace in the last 10 minutes.",
      `Re-run with --from ${first.source} (most recent) or --from ${second.source}.`
    );
  }
  return parseCandidate(first, options.budget);
}

/** Primary agent sessions, most relevant first. Subagent and reviewer threads are excluded. */
export function listSessionCandidates(options: { cwd: string; repoRoot?: string; from?: SessionFrom; includeSecondary?: boolean }): SessionCandidate[] {
  const scope = toScope(options.cwd, options.repoRoot);
  const from = options.from || "auto";
  return [
    ...(from !== "claude" ? findCodexCandidates(scope, options.includeSecondary === true) : []),
    ...(from !== "codex" ? findClaudeCandidates(scope, options.includeSecondary === true) : [])
  ].sort(compareCandidates);
}

function normalizeFrom(from: string): SessionFrom {
  if (from === "auto" || from === "codex" || from === "claude") return from;
  throw new CtxError(`Unsupported --from value "${from}".`, "Use auto, codex, or claude.");
}

function resolveExplicitSession(from: SessionFrom, scope: Scope, session: string, budget?: number): SourceSession {
  const asPath = resolve(session);
  if (existsSync(asPath) && statSync(asPath).isFile()) {
    const source = from === "auto" ? detectSource(asPath) : from;
    const parsed = source === "claude" ? parseClaudeSession(asPath, budget) : parseCodexSession(asPath, budget);
    parsed.matchedCwd = matchesWorkspace(parsed.cwd, scope);
    return parsed;
  }

  const match = listSessionCandidates({ ...scope, from, includeSecondary: true }).find(
    (candidate) => candidate.id === session || candidate.id.startsWith(session) || basename(candidate.path).includes(session)
  );
  if (!match) throw new CtxError(`No session matched "${session}".`, "Pass an id from `ctxpool sessions --all` or a path to a .jsonl file.");
  return parseCandidate(match, budget);
}

function parseCandidate(candidate: SessionCandidate, budget?: number): SourceSession {
  const session = candidate.source === "codex" ? parseCodexSession(candidate.path, budget) : parseClaudeSession(candidate.path, budget);
  session.id = candidate.id || session.id;
  session.cwd = session.cwd || candidate.cwd;
  session.updatedAt = candidate.updatedAt;
  session.matchedCwd = candidate.matchedCwd;
  session.threadName = session.threadName || candidate.title;
  return session;
}

function compareCandidates(a: SessionCandidate, b: SessionCandidate): number {
  if (a.matchedCwd !== b.matchedCwd) return a.matchedCwd ? -1 : 1;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

// ---------------------------------------------------------------------------
// Discovery

function findCodexCandidates(scope: Scope, includeSecondary: boolean): SessionCandidate[] {
  const index = readCodexIndex();
  const candidates: SessionCandidate[] = [];
  for (const path of findRecentFiles(join(codexHome(), "sessions"), MAX_CANDIDATES, /\.jsonl$/i)) {
    const meta = readCodexMeta(path);
    if (meta.secondary && !includeSecondary) continue;
    const id = meta.id || sessionIdFromPath(path);
    candidates.push({
      source: "codex",
      path,
      id,
      cwd: meta.cwd,
      updatedAt: mtimeIso(path),
      matchedCwd: matchesWorkspace(meta.cwd, scope),
      title: index.get(id)
    });
  }
  return candidates;
}

function findClaudeCandidates(scope: Scope, includeSecondary: boolean): SessionCandidate[] {
  const projects = join(claudeHome(), "projects");
  const preferred = unique([scope.cwd, scope.repoRoot || ""].filter(Boolean).map((path) => join(projects, encodeClaudeProjectPath(path)))).filter(existsSync);
  const roots = preferred.length ? preferred : [projects];
  const skipDirs = includeSecondary ? [] : ["subagents"];
  const candidates: SessionCandidate[] = [];
  for (const path of roots.flatMap((root) => findRecentFiles(root, MAX_CANDIDATES, /\.jsonl$/i, skipDirs))) {
    const meta = readClaudeMeta(path);
    if (!meta.cwd && !meta.id) continue;
    candidates.push({
      source: "claude",
      path,
      id: meta.id || sessionIdFromPath(path),
      cwd: meta.cwd,
      updatedAt: mtimeIso(path),
      matchedCwd: matchesWorkspace(meta.cwd, scope),
      title: meta.title
    });
  }
  return candidates;
}

function readCodexMeta(path: string): { id?: string; cwd?: string; secondary: boolean } {
  const record = objectValue(parseJson(readFirstLine(path)));
  if (stringValue(record.type) !== "session_meta") return { secondary: false };
  const payload = objectValue(record.payload);
  const threadSource = stringValue(payload.thread_source);
  const source = payload.source;
  const secondary =
    threadSource === "subagent" || threadSource === "guardian_review" || (typeof source === "object" && source !== null && "subagent" in source);
  return { id: stringValue(payload.id) || undefined, cwd: stringValue(payload.cwd) || undefined, secondary };
}

function readClaudeMeta(path: string): { id?: string; cwd?: string; title?: string } {
  let id: string | undefined;
  let cwd: string | undefined;
  let firstPrompt: string | undefined;
  for (const line of readHead(path, 128_000).split(/\r?\n/).slice(0, 60)) {
    const record = objectValue(parseJson(line));
    id ||= stringValue(record.sessionId) || undefined;
    cwd ||= stringValue(record.cwd) || undefined;
    if (!firstPrompt && record.type === "user" && !record.isMeta && !record.isSidechain) {
      const content = objectValue(record.message).content;
      if (typeof content === "string") firstPrompt = cleanText(parseClaudeUserText(content).prompt) || undefined;
    }
    if (id && cwd && firstPrompt) break;
  }
  let title: string | undefined;
  for (const line of readTail(path, 96_000).split(/\r?\n/)) {
    if (!line.includes("title") && !line.includes("summary")) continue;
    const record = objectValue(parseJson(line));
    title = claudeTitle(record) || title;
  }
  return { id, cwd, title: title || (firstPrompt ? truncate(oneLine(firstPrompt), 80) : undefined) };
}

function readCodexIndex(): Map<string, string> {
  const map = new Map<string, string>();
  const indexPath = join(codexHome(), "session_index.jsonl");
  if (!existsSync(indexPath)) return map;
  for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    const record = objectValue(parseJson(line));
    const id = stringValue(record.id);
    const name = stringValue(record.thread_name);
    if (id && name) map.set(id, name);
  }
  return map;
}

function detectSource(path: string): SourceAgent {
  for (const line of readHead(path, 64_000).split(/\r?\n/).slice(0, 10)) {
    const record = objectValue(parseJson(line));
    if (record.type === "session_meta" || "payload" in record) return "codex";
    if ("sessionId" in record || "message" in record) return "claude";
  }
  return path.includes(`${join(".claude", "projects")}`) ? "claude" : "codex";
}

// ---------------------------------------------------------------------------
// Parsing

class SessionBuilder {
  readonly transcript: TranscriptEntry[] = [];
  readonly commands: CommandRun[] = [];
  readonly edits: FileEdit[] = [];
  plan?: PlanItem[];
  planText?: string;
  compactSummary?: string;
  readonly links: string[] = [];
  private seq = 0;
  private readonly pendingCommands = new Map<string, { index: number; assumeSuccess: boolean }>();

  message(role: "user" | "assistant", text: string, timestamp?: string): void {
    const clean = cleanText(text);
    if (!isUsefulText(clean)) return;
    const last = this.transcript.at(-1);
    if (last && last.role === role && last.text === clean) return;
    this.seq++;
    this.transcript.push({ role, text: clean, timestamp, kind: "message" });
  }

  toolCall(name: string, detail: string, timestamp?: string): void {
    this.seq++;
    this.transcript.push({ role: "tool", text: detail ? `${name}: ${truncate(oneLine(detail), 240)}` : name, timestamp, kind: "tool_call" });
  }

  /**
   * Record a command whose result may arrive later under `callId`. `assumeSuccess` marks logs where a
   * result without an error flag means exit 0 (Claude); elsewhere a missing exit code stays unknown.
   */
  commandCall(callId: string, command: string, timestamp?: string, assumeSuccess = false): void {
    if (!command) return;
    this.toolCall("Shell", command, timestamp);
    this.recordCommand(command, undefined, "");
    if (callId) this.pendingCommands.set(callId, { index: this.commands.length - 1, assumeSuccess });
  }

  commandResult(callId: string, output: string, options: { isError?: boolean; exitCode?: number } = {}): void {
    const pending = this.pendingCommands.get(callId);
    if (!pending) return;
    this.pendingCommands.delete(callId);
    const exitCode = options.exitCode ?? parseExitCode(output) ?? (options.isError ? 1 : pending.assumeSuccess ? 0 : undefined);
    const run = { ...this.commands[pending.index], ...commandOutcome(this.commands[pending.index].command, exitCode, output) };
    this.commands[pending.index] = run;
    if (run.status === "failed") this.pushFailure(run);
  }

  /** A command whose call and result are logged together. */
  command(command: string, exitCode: number | undefined, output: string, timestamp?: string): void {
    if (!command) return;
    this.toolCall("Shell", command, timestamp);
    this.recordCommand(command, exitCode, output);
  }

  edit(path: string, timestamp?: string): void {
    if (!path) return;
    this.seq++;
    this.edits.push({ path, seq: this.seq });
    this.transcript.push({ role: "tool", text: `Edit: ${path}`, timestamp, kind: "edit" });
  }

  setPlan(items: PlanItem[]): void {
    if (items.length) this.plan = items;
  }

  updatePlan(update: { advance?: boolean; done?: number[]; start?: number }): void {
    if (!this.plan) return;
    const plan = this.plan.map((item) => ({ ...item }));
    if (update.advance) {
      const current = plan.findIndex((item) => item.status === "in_progress");
      if (current >= 0) plan[current].status = "completed";
      const next = plan.findIndex((item, index) => index > current && item.status === "pending");
      if (next >= 0) plan[next].status = "in_progress";
    }
    for (const index of update.done || []) if (plan[index - 1]) plan[index - 1].status = "completed";
    if (update.start && plan[update.start - 1]) plan[update.start - 1].status = "in_progress";
    this.plan = plan;
  }

  private recordCommand(command: string, exitCode: number | undefined, output: string): void {
    this.seq++;
    const run: CommandRun = { command: truncate(oneLine(command), 400), ...commandOutcome(command, exitCode, output), seq: this.seq };
    this.commands.push(run);
    if (run.status === "failed") this.pushFailure(run);
  }

  private pushFailure(run: CommandRun): void {
    const label = run.exitCode ? `Exit ${run.exitCode}` : "Failed";
    this.transcript.push({ role: "tool", text: `${label}${run.errorLine ? `: ${run.errorLine}` : ""}`, kind: "tool_error" });
  }
}

function commandOutcome(command: string, exitCode: number | undefined, output: string): Pick<CommandRun, "status" | "exitCode" | "errorLine"> {
  const status = commandStatus(command, exitCode, output);
  return { status, exitCode, errorLine: status === "failed" ? firstErrorLine(output) : undefined };
}

export function parseCodexSession(path: string, budget = DEFAULT_EXCERPT_TOKENS): SourceSession {
  const lines = readSessionLines(path);
  const builder = new SessionBuilder();
  let id = sessionIdFromPath(path);
  let cwd: string | undefined;

  // Newer Codex logs record typed items; older ones mirror messages across event_msg and response_item.
  const mode = lines.some((line) => line.includes('"item_completed"'))
    ? "items"
    : lines.some((line) => line.includes('"user_message"'))
      ? "events"
      : "responses";

  for (const line of lines) {
    const record = objectValue(parseJson(line));
    const type = stringValue(record.type);
    const payload = objectValue(record.payload);
    const timestamp = stringValue(record.timestamp) || stringValue(payload.timestamp) || undefined;

    if (type === "session_meta") {
      id = stringValue(payload.id) || id;
      cwd = stringValue(payload.cwd) || cwd;
      continue;
    }
    if (type === "compacted") {
      const message = stringValue(payload.message);
      if (message.trim()) builder.compactSummary = cleanText(message);
      continue;
    }

    if (type === "event_msg") {
      const eventType = stringValue(payload.type);
      if (mode === "items" && eventType === "item_completed") {
        readCodexItem(builder, objectValue(payload.item), timestamp);
      } else if (mode === "events" && eventType === "user_message") {
        builder.message("user", stringValue(payload.message), timestamp);
      } else if (mode === "events" && eventType === "agent_message") {
        builder.message("assistant", stringValue(payload.message), timestamp);
      } else if (mode !== "items" && eventType === "exec_command_end") {
        builder.commandResult(stringValue(payload.call_id), outputText(payload.aggregated_output ?? payload.stdout ?? payload.formatted_output), {
          exitCode: numberValue(payload.exit_code)
        });
      }
      continue;
    }

    if (type !== "response_item") continue;
    const itemType = stringValue(payload.type);
    if (itemType === "message" && mode === "responses") {
      const role = stringValue(payload.role);
      if (role === "user" || role === "assistant") builder.message(role, collectText(payload.content).join("\n"), timestamp);
    } else if (itemType === "function_call" || itemType === "custom_tool_call" || itemType === "local_shell_call") {
      readCodexCall(builder, payload, mode, timestamp);
    } else if ((itemType === "function_call_output" || itemType === "custom_tool_call_output") && mode !== "items") {
      const output = outputText(payload.output);
      builder.commandResult(stringValue(payload.call_id), output, { exitCode: parseExitCode(output) });
    }
  }

  return buildSession({
    source: "codex",
    id,
    path,
    cwd,
    lineCount: lines.length,
    builder,
    budget,
    threadName: undefined
  });
}

function readCodexItem(builder: SessionBuilder, item: Record<string, unknown>, timestamp?: string): void {
  switch (stringValue(item.type)) {
    case "UserMessage":
      builder.message("user", collectText(item.content).join("\n"), timestamp);
      return;
    case "AgentMessage":
      builder.message("assistant", collectText(item.content).join("\n"), timestamp);
      return;
    case "CommandExecution": {
      const command = Array.isArray(item.command) ? shellCommand(item.command) : stringValue(item.command);
      builder.command(command, numberValue(item.exit_code) ?? (stringValue(item.status) === "failed" ? 1 : undefined), outputText(item.aggregated_output), timestamp);
      return;
    }
    case "FileChange":
      for (const path of Object.keys(objectValue(item.changes))) builder.edit(path, timestamp);
      return;
    case "McpToolCall":
      builder.toolCall(`${stringValue(item.server)}.${stringValue(item.tool)}`, stringValue(item.status) === "failed" ? "failed" : "", timestamp);
      return;
    case "TodoList": {
      const items = Array.isArray(item.items) ? item.items.map(objectValue) : [];
      builder.setPlan(
        items
          .map((entry): PlanItem => ({ text: oneLine(stringValue(entry.text)), status: entry.completed === true ? "completed" : "pending" }))
          .filter((entry) => entry.text)
      );
      return;
    }
  }
}

function readCodexCall(builder: SessionBuilder, payload: Record<string, unknown>, mode: string, timestamp?: string): void {
  const name = stringValue(payload.name);
  const callId = stringValue(payload.call_id);
  const rawArgs = stringValue(payload.arguments) || stringValue(payload.input);
  const args = objectValue(parseJson(rawArgs));

  if (name === "update_plan") {
    builder.setPlan(planItemsFrom(args.plan));
    return;
  }
  // Items mode records commands and edits as typed items; skip the raw calls to avoid double counting.
  if (mode === "items") return;

  if (name === "apply_patch") {
    for (const path of patchFiles(rawArgs)) builder.edit(path, timestamp);
    return;
  }
  if (stringValue(payload.type) === "local_shell_call") {
    const action = objectValue(payload.action);
    builder.command(Array.isArray(action.command) ? shellCommand(action.command) : "", undefined, "", timestamp);
    return;
  }
  if (name === "shell" || name === "container.exec" || name === "local_shell" || name === "exec_command") {
    const command = Array.isArray(args.command) ? shellCommand(args.command) : stringValue(args.cmd) || stringValue(args.command);
    if (command.includes("apply_patch")) {
      for (const path of patchFiles(command)) builder.edit(path, timestamp);
      return;
    }
    builder.commandCall(callId, command, timestamp);
    return;
  }
  if (name) builder.toolCall(name, "", timestamp);
}

export function parseClaudeSession(path: string, budget = DEFAULT_EXCERPT_TOKENS): SourceSession {
  const lines = readSessionLines(path);
  const builder = new SessionBuilder();
  let id = sessionIdFromPath(path);
  let cwd: string | undefined;
  let title: string | undefined;

  for (const line of lines) {
    const record = objectValue(parseJson(line));
    const type = stringValue(record.type);

    const recordTitle = claudeTitle(record);
    if (recordTitle) {
      title = recordTitle;
      continue;
    }
    if (type === "pr-link" && stringValue(record.prUrl)) {
      builder.links.push(stringValue(record.prUrl));
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    if (record.isMeta === true || record.isSidechain === true) continue;

    id = stringValue(record.sessionId) || id;
    cwd = stringValue(record.cwd) || cwd;
    const timestamp = stringValue(record.timestamp) || undefined;
    const content = objectValue(record.message).content;

    if (record.isCompactSummary === true) {
      builder.compactSummary = cleanText(collectText(content).join("\n"));
      continue;
    }

    if (type === "user") {
      if (typeof content === "string") {
        const parsed = parseClaudeUserText(content);
        if (parsed.prompt) builder.message("user", parsed.prompt, timestamp);
        continue;
      }
      const texts: string[] = [];
      for (const block of Array.isArray(content) ? content.map(objectValue) : []) {
        if (block.type === "text") {
          const parsed = parseClaudeUserText(stringValue(block.text));
          if (parsed.prompt) texts.push(parsed.prompt);
        } else if (block.type === "tool_result") {
          builder.commandResult(stringValue(block.tool_use_id), collectText(block.content).join("\n"), { isError: block.is_error === true });
        }
      }
      if (texts.length) builder.message("user", texts.join("\n"), timestamp);
      continue;
    }

    for (const block of Array.isArray(content) ? content.map(objectValue) : []) {
      if (block.type === "text") builder.message("assistant", stringValue(block.text), timestamp);
      else if (block.type === "tool_use") readClaudeTool(builder, stringValue(block.name), objectValue(block.input), stringValue(block.id), timestamp);
    }
  }

  return buildSession({
    source: "claude",
    id,
    path,
    cwd,
    lineCount: lines.length,
    builder,
    budget,
    threadName: title,
    supplementalPaths: latestClaudeSupplementalPaths()
  });
}

function readClaudeTool(builder: SessionBuilder, name: string, input: Record<string, unknown>, callId: string, timestamp?: string): void {
  if (name === "Bash" || name === "PowerShell") {
    builder.commandCall(callId, stringValue(input.command), timestamp, input.run_in_background !== true);
    return;
  }
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    builder.edit(stringValue(input.file_path) || stringValue(input.notebook_path), timestamp);
    return;
  }
  if (name === "ExitPlanMode") {
    if (stringValue(input.plan)) builder.planText = cleanText(stringValue(input.plan));
    return;
  }
  const planItems = planItemsFrom(input.todos ?? input.items ?? input.plan);
  if (planItems.length) {
    builder.setPlan(planItems);
    return;
  }
  if (/update_plan$/.test(name)) {
    builder.updatePlan({
      advance: input.advance === true,
      done: Array.isArray(input.done) ? input.done.filter((value): value is number => typeof value === "number") : undefined,
      start: numberValue(input.start)
    });
    return;
  }
  const detail = stringValue(input.file_path) || stringValue(input.pattern) || stringValue(input.url) || stringValue(input.query) || stringValue(input.description);
  builder.toolCall(name, detail, timestamp);
}

function parseClaudeUserText(text: string): { prompt: string } {
  const commandName = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (commandName) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return { prompt: [commandName, args].filter(Boolean).join(" ") };
  }
  if (/^\s*<(?:local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|task-notification)>/.test(text)) return { prompt: "" };
  if (/^\[Request interrupted by user/.test(text.trim())) return { prompt: "" };
  return { prompt: text };
}

function claudeTitle(record: Record<string, unknown>): string | undefined {
  switch (record.type) {
    case "custom-title":
      return stringValue(record.customTitle) || undefined;
    case "ai-title":
      return stringValue(record.aiTitle) || undefined;
    case "summary":
      return stringValue(record.summary) || undefined;
    default:
      return undefined;
  }
}

function buildSession(args: {
  source: SourceAgent;
  id: string;
  path: string;
  cwd?: string;
  lineCount: number;
  builder: SessionBuilder;
  budget: number;
  threadName?: string;
  supplementalPaths?: string[];
}): SourceSession {
  const { builder } = args;
  return {
    source: args.source,
    id: args.id,
    path: args.path,
    cwd: args.cwd,
    updatedAt: mtimeIso(args.path),
    matchedCwd: false,
    lineCount: args.lineCount,
    transcript: builder.transcript,
    transcriptExcerpt: renderTranscriptExcerpt(builder.transcript, args.budget),
    threadName: args.threadName,
    supplementalPaths: args.supplementalPaths,
    plan: builder.plan,
    planText: builder.planText,
    commands: builder.commands,
    edits: builder.edits,
    compactSummary: builder.compactSummary,
    links: unique(builder.links)
  };
}

/** Most recent conversation (and failures) that fits the token budget, oldest first. Routine tool calls are left out. */
export function renderTranscriptExcerpt(entries: TranscriptEntry[], budgetTokens = DEFAULT_EXCERPT_TOKENS): string {
  const maxChars = Math.max(500, budgetTokens * 4);
  const rendered: string[] = [];
  let used = 0;
  for (const entry of [...entries].reverse()) {
    if (entry.kind === "tool_call" || entry.kind === "edit") continue;
    const text = entry.role === "tool" ? entry.text : truncate(entry.text, 1_500);
    const line = `[${entry.role}] ${text}`;
    if (used + line.length > maxChars) break;
    rendered.unshift(line);
    used += line.length + 1;
  }
  return rendered.join("\n");
}

function latestClaudeSupplementalPaths(): string[] {
  const root = claudeHome();
  return unique([...findRecentFiles(join(root, "plans"), 3, /\.md$/i), ...findRecentFiles(join(root, "tasks"), 3, /\.json$/i)]);
}

// ---------------------------------------------------------------------------
// Text helpers

const NOISE_BLOCKS = [
  "system-reminder",
  "local-command-caveat",
  "permissions instructions",
  "app-context",
  "collaboration_mode",
  "skills_instructions",
  "plugins_instructions",
  "environment_context",
  "user_instructions",
  "INSTRUCTIONS"
];

function cleanText(text: string): string {
  let next = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  for (const tag of NOISE_BLOCKS) next = next.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  return next.replace(/"encrypted_content":"[^"]+"/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function isUsefulText(text: string): boolean {
  if (!text || text.length < 2) return false;
  if (/^(?:# AGENTS\.md instructions|# Handoff[:\s·]|<environment_context>|<user_instructions>|<turn_aborted>)/.test(text)) return false;
  if (/You are Codex|Knowledge cutoff:|Filesystem sandboxing defines|DO NOT respond to these messages/.test(text)) return false;
  return true;
}

function planItemsFrom(value: unknown): PlanItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(objectValue)
    .map((entry) => ({
      text: oneLine(stringValue(entry.content) || stringValue(entry.step) || stringValue(entry.text) || stringValue(entry.subject)),
      status: planStatus(entry.status)
    }))
    .filter((entry) => entry.text && entry.status !== undefined) as PlanItem[];
}

function planStatus(value: unknown): PlanStatus | undefined {
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "in-progress" || value === "active") return "in_progress";
  if (value === "pending" || value === "todo" || value === "not_started") return "pending";
  return undefined;
}

function patchFiles(patch: string): string[] {
  return unique(Array.from(patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n\\"]+)/g), (match) => match[1].trim()));
}

function shellCommand(parts: unknown[]): string {
  const strings = parts.filter((part): part is string => typeof part === "string");
  if (strings.length >= 3 && /(?:^|\/)(?:ba|z|fi)?sh$/.test(strings[0]) && /^-l?c$/.test(strings[1])) return strings.slice(2).join(" ");
  return strings.join(" ");
}

function parseExitCode(output: string): number | undefined {
  const match =
    /"exit_code"\s*:\s*(-?\d+)/.exec(output) ||
    /Process exited with code (-?\d+)/i.exec(output) ||
    /^Exit code:?\s*(-?\d+)/im.exec(output);
  return match ? Number(match[1]) : undefined;
}

function firstErrorLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim())
    .filter((line) => line && !/^(?:Exit code|Process exited|Wall time|Chunk ID|Output:)/i.test(line));
  const line = lines.find((candidate) => /(error|fail|exception|traceback|cannot|not found|denied|panic|assert|expected)/i.test(candidate)) || lines[0];
  return line ? truncate(line, 200) : undefined;
}

function outputText(value: unknown): string {
  if (typeof value === "string") {
    const parsed = objectValue(parseJson(value));
    if (typeof parsed.output === "string") {
      const exit = numberValue(objectValue(parsed.metadata).exit_code);
      return exit === undefined ? parsed.output : `Exit code: ${exit}\n${parsed.output}`;
    }
    return value;
  }
  return collectText(value).join("\n");
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return ["text", "content", "output"].flatMap((key) => collectText(record[key]));
}

function sessionIdFromPath(path: string): string {
  return basename(path)
    .replace(/\.(jsonl|json)$/i, "")
    .replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "");
}

function matchesWorkspace(sessionCwd: string | undefined, scope: Scope): boolean {
  if (!sessionCwd) return false;
  const target = canonicalPath(sessionCwd);
  if (target === scope.cwd) return true;
  return Boolean(scope.repoRoot && isInside(target, scope.repoRoot));
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toScope(cwd: string, repoRoot?: string): Scope {
  return { cwd: canonicalPath(cwd), repoRoot: repoRoot ? canonicalPath(repoRoot) : undefined };
}

/** Claude Code stores projects under the cwd with every non-alphanumeric character replaced by "-". */
export function encodeClaudeProjectPath(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJson(line: string): unknown {
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function mtimeIso(path: string): string {
  return statSync(path).mtime.toISOString();
}

// ---------------------------------------------------------------------------
// File reading

function readSessionLines(path: string): string[] {
  const size = statSync(path).size;
  const text = size <= 16_000_000 ? readFileSync(path, "utf8") : `${readSlice(path, 0, 2_000_000)}\n${readSlice(path, size - 10_000_000, 10_000_000)}`;
  return text.split(/\r?\n/).filter(Boolean);
}

function readFirstLine(path: string, maxBytes = 2_000_000): string {
  let length = 32_000;
  while (true) {
    const chunk = readSlice(path, 0, length);
    const newline = chunk.indexOf("\n");
    if (newline >= 0) return chunk.slice(0, newline);
    if (chunk.length < length || length >= maxBytes) return chunk;
    length *= 4;
  }
}

function readHead(path: string, bytes: number): string {
  return readSlice(path, 0, bytes);
}

function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  return readSlice(path, Math.max(0, size - bytes), Math.min(bytes, size));
}

function readSlice(path: string, position: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
