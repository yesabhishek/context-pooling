import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** Gemini CLI keeps its data in `.gemini` under GEMINI_CLI_HOME, or under the home directory. */
export function geminiHome(): string {
  return join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini");
}

/**
 * Antigravity CLI (`agy`) always keeps its data in ~/.gemini/antigravity-cli. CTXPOOL_ANTIGRAVITY_DIR points
 * ContextPool somewhere else; agy itself does not read it.
 */
export function antigravityHome(): string {
  return process.env.CTXPOOL_ANTIGRAVITY_DIR || join(homedir(), ".gemini", "antigravity-cli");
}

/** Every agent ContextPool can read, in the order `--from auto` lists them. */
export const SOURCE_AGENTS: readonly SourceAgent[] = ["codex", "claude", "gemini", "antigravity"];

const SOURCE_LABELS: Record<SourceAgent, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini", antigravity: "Antigravity" };

export function sourceLabel(source: SourceAgent): string {
  return SOURCE_LABELS[source] || source;
}

/** Where each agent keeps the sessions ContextPool reads. */
export function sourceSessionDirs(): Record<SourceAgent, string> {
  return {
    codex: join(codexHome(), "sessions"),
    claude: join(claudeHome(), "projects"),
    gemini: join(geminiHome(), "tmp"),
    antigravity: join(antigravityHome(), "conversations")
  };
}

export function resolveSessionSource(options: ResolveSessionOptions): SourceSession {
  const from = normalizeFrom(options.from || "auto");
  const scope = toScope(options.cwd, options.repoRoot);

  if (options.session) return resolveExplicitSession(from, scope, options.session, options.budget);

  const matched = listSessionCandidates({ ...scope, from }).filter((candidate) => candidate.matchedCwd);
  const [first] = matched;
  if (!first) {
    const label = from === "auto" ? joinWords(SOURCE_AGENTS.map(sourceLabel), "or") : sourceLabel(from);
    throw new CtxError(`No ${label} session found for ${scope.cwd}.`, "Run `ctxpool sessions --all` to list sessions, then pass --session <id or path>.");
  }
  if (from === "auto") {
    const recent = matched.filter((candidate) => Date.parse(first.updatedAt) - Date.parse(candidate.updatedAt) < AMBIGUITY_WINDOW_MS);
    const active = Array.from(new Set(recent.map((candidate) => candidate.source)));
    if (active.length > 1) {
      throw new CtxError(
        `${joinWords(active.map(sourceLabel), "and")} were ${active.length === 2 ? "both" : "all"} active in this workspace in the last 10 minutes.`,
        `Re-run with ${joinWords(active.map((source, index) => `--from ${source}${index === 0 ? " (most recent)" : ""}`), "or")}.`
      );
    }
  }
  return parseCandidate(first, options.budget);
}

/** Primary agent sessions, most relevant first. Subagent and reviewer threads are excluded. */
export function listSessionCandidates(options: { cwd: string; repoRoot?: string; from?: SessionFrom; includeSecondary?: boolean }): SessionCandidate[] {
  const scope = toScope(options.cwd, options.repoRoot);
  const from = options.from || "auto";
  const sources = from === "auto" ? SOURCE_AGENTS : [from];
  return sources.flatMap((source) => CANDIDATE_FINDERS[source](scope, options.includeSecondary === true)).sort(compareCandidates);
}

function normalizeFrom(from: string): SessionFrom {
  if (from === "auto" || (SOURCE_AGENTS as readonly string[]).includes(from)) return from as SessionFrom;
  throw new CtxError(`Unsupported --from value "${from}".`, `Use ${joinWords(["auto", ...SOURCE_AGENTS], "or")}.`);
}

function resolveExplicitSession(from: SessionFrom, scope: Scope, session: string, budget?: number): SourceSession {
  const asPath = resolve(session);
  if (existsSync(asPath) && statSync(asPath).isFile()) {
    const source = from === "auto" ? detectSource(asPath) : from;
    const parsed = SESSION_PARSERS[source](asPath, budget);
    parsed.matchedCwd = matchesWorkspace(parsed.cwd, scope);
    return parsed;
  }

  const match = listSessionCandidates({ ...scope, from, includeSecondary: true }).find(
    (candidate) => candidate.id === session || candidate.id.startsWith(session) || basename(candidate.path).includes(session)
  );
  if (!match) throw new CtxError(`No session matched "${session}".`, "Pass an id from `ctxpool sessions --all` or a path to a session file.");
  return parseCandidate(match, budget);
}

function parseCandidate(candidate: SessionCandidate, budget?: number): SourceSession {
  const session = SESSION_PARSERS[candidate.source](candidate.path, budget);
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

/** "a", "a or b", "a, b, or c". */
function joinWords(words: readonly string[], conjunction: "and" | "or"): string {
  if (words.length <= 2) return words.join(` ${conjunction} `);
  return `${words.slice(0, -1).join(", ")}, ${conjunction} ${words.at(-1)}`;
}

const CANDIDATE_FINDERS: Record<SourceAgent, (scope: Scope, includeSecondary: boolean) => SessionCandidate[]> = {
  codex: findCodexCandidates,
  claude: findClaudeCandidates,
  gemini: findGeminiCandidates,
  antigravity: findAntigravityCandidates
};

const SESSION_PARSERS: Record<SourceAgent, (path: string, budget?: number) => SourceSession> = {
  codex: parseCodexSession,
  claude: parseClaudeSession,
  gemini: parseGeminiSession,
  antigravity: parseAntigravitySession
};

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

/**
 * Gemini CLI writes one chat per session to tmp/<project>/chats/session-<time>-<id>.jsonl (a single .json file in
 * older builds). Subagent chats sit in a folder named after the parent session.
 */
function findGeminiCandidates(scope: Scope, includeSecondary: boolean): SessionCandidate[] {
  const tmp = join(geminiHome(), "tmp");
  const registry = readGeminiProjectRegistry();
  const byId = new Map<string, SessionCandidate>();
  for (const project of listDirectories(tmp)) {
    const chats = join(tmp, project, "chats");
    const projectRoot = readGeminiProjectRoot(join(tmp, project), registry);
    for (const path of findRecentFiles(chats, MAX_CANDIDATES, /\.jsonl?$/i)) {
      const meta = readGeminiMeta(path);
      if (!meta.id) continue;
      if ((meta.subagent || dirname(path) !== chats) && !includeSecondary) continue;
      const cwd = projectRoot || geminiRootFromHash(meta.projectHash, scope);
      const candidate: SessionCandidate = {
        source: "gemini",
        path,
        id: meta.id,
        cwd,
        updatedAt: mtimeIso(path),
        matchedCwd: matchesWorkspace(cwd, scope),
        title: meta.title
      };
      // Resuming an old .json chat copies it to a .jsonl file beside the original; keep the newer copy.
      const existing = byId.get(meta.id);
      if (!existing || Date.parse(candidate.updatedAt) > Date.parse(existing.updatedAt)) byId.set(meta.id, candidate);
    }
  }
  return [...byId.values()];
}

function readGeminiMeta(path: string): { id?: string; projectHash?: string; subagent: boolean; title?: string } {
  let metadata: Record<string, unknown> = {};
  let firstPrompt = "";
  if (/\.json$/i.test(path)) {
    const conversation = readGeminiConversation(path);
    metadata = conversation.metadata;
    firstPrompt = conversation.messages.map(geminiUserPrompt).find(Boolean) || "";
  } else {
    for (const line of readHead(path, 128_000).split(/\r?\n/).slice(0, 60)) {
      const record = objectValue(parseJson(line));
      if (typeof record.sessionId === "string" && typeof record.projectHash === "string") metadata = { ...metadata, ...record };
      else if (!firstPrompt && record.type === "user") firstPrompt = geminiUserPrompt(record);
    }
    for (const line of readTail(path, 96_000).split(/\r?\n/)) {
      if (!line.includes('"summary"')) continue;
      const summary = stringValue(objectValue(objectValue(parseJson(line)).$set).summary);
      if (summary) metadata.summary = summary;
    }
  }
  return {
    id: stringValue(metadata.sessionId) || undefined,
    projectHash: stringValue(metadata.projectHash) || undefined,
    subagent: metadata.kind === "subagent",
    title: stringValue(metadata.summary) || (firstPrompt ? truncate(oneLine(firstPrompt), 80) : undefined)
  };
}

/** projects.json maps each project root to the short folder name Gemini uses under tmp/. */
function readGeminiProjectRegistry(): Map<string, string> {
  const map = new Map<string, string>();
  const path = join(geminiHome(), "projects.json");
  if (!existsSync(path)) return map;
  for (const [root, name] of Object.entries(objectValue(objectValue(parseJson(readFileSync(path, "utf8"))).projects))) {
    if (typeof name === "string") map.set(name, root);
  }
  return map;
}

function readGeminiProjectRoot(projectDir: string, registry = readGeminiProjectRegistry()): string | undefined {
  const marker = join(projectDir, ".project_root");
  const root = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  return root || registry.get(basename(projectDir));
}

/** Older Gemini builds name project folders by the SHA-256 of the project root and leave no marker file. */
function geminiRootFromHash(projectHash: string | undefined, scope: Scope): string | undefined {
  if (!projectHash) return undefined;
  return [scope.cwd, scope.repoRoot].find((root) => root && createHash("sha256").update(root).digest("hex") === projectHash);
}

/** The tmp/<project> folder that holds a chat file, for main and subagent chats alike. */
function geminiProjectDir(path: string): string | undefined {
  let dir = dirname(path);
  for (let depth = 0; depth < 2; depth++, dir = dirname(dir)) if (basename(dir) === "chats") return dirname(dir);
  return undefined;
}

type AntigravitySummary = { cwd?: string; title?: string; parentId?: string };

/**
 * Antigravity CLI stores each conversation as a SQLite database, conversations/<id>.db, and indexes them in
 * conversation_summaries.db. Subagent conversations name their parent there and in their own metadata.
 */
function findAntigravityCandidates(scope: Scope, includeSecondary: boolean): SessionCandidate[] {
  const index = readAntigravityIndex();
  const candidates: SessionCandidate[] = [];
  for (const path of findRecentFiles(join(antigravityHome(), "conversations"), MAX_CANDIDATES, /\.db$/i)) {
    const id = antigravityId(path);
    const summary = index.get(id) || readAntigravityMetadata(path);
    if (summary.parentId && !includeSecondary) continue;
    candidates.push({
      source: "antigravity",
      path,
      id,
      cwd: summary.cwd,
      updatedAt: antigravityUpdatedAt(path),
      matchedCwd: matchesWorkspace(summary.cwd, scope),
      title: summary.title
    });
  }
  return candidates;
}

function readAntigravityIndex(): Map<string, AntigravitySummary> {
  const index = new Map<string, AntigravitySummary>();
  const db = openAntigravityDb(join(antigravityHome(), "conversation_summaries.db"));
  if (!db) return index;
  try {
    const rows = db.prepare("SELECT conversation_id, title, workspace_uris, parent_conversation_id FROM conversation_summaries").all();
    for (const row of rows) {
      const workspaces = parseJson(String(row.workspace_uris ?? ""));
      index.set(String(row.conversation_id), {
        cwd: fileUriToPath(Array.isArray(workspaces) ? stringValue(workspaces[0]) : ""),
        title: String(row.title ?? "") || undefined,
        parentId: String(row.parent_conversation_id ?? "") || undefined
      });
    }
  } catch {
    // An older or newer index layout; each conversation's own metadata still names its workspace.
  } finally {
    db.close();
  }
  return index;
}

/** For conversations missing from the index: the workspace from their own metadata, titled by the first prompt still on record. */
function readAntigravityMetadata(path: string): AntigravitySummary {
  const db = openAntigravityDb(path);
  if (!db) return {};
  try {
    const row = db.prepare("SELECT step_payload FROM steps WHERE step_type = ? AND status != ? ORDER BY idx LIMIT 1").get(AGY_STEP.userInput, AGY_STATUS.cleared);
    const prompt = row?.step_payload instanceof Uint8Array ? antigravityPrompt(pbMessage(pbDecode(row.step_payload), 19)) : "";
    return { ...antigravityTrajectoryMetadata(db), title: prompt ? truncate(oneLine(cleanText(prompt)), 80) : undefined };
  } catch {
    return antigravityTrajectoryMetadata(db);
  } finally {
    db.close();
  }
}

/** The CortexTrajectoryMetadata proto: workspaces[].workspace_folder_absolute_uri (1.1), workspace_uris (7), parent_conversation_id (5). */
function antigravityTrajectoryMetadata(db: DatabaseSync): AntigravitySummary {
  try {
    const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
    const metadata = pbDecode(row?.data instanceof Uint8Array ? row.data : undefined);
    const uri = pbString(pbMessage(metadata, 1), 1) || pbString(metadata, 7);
    return { cwd: fileUriToPath(uri), parentId: pbString(metadata, 5) || undefined };
  } catch {
    return {};
  }
}

/** agy writes recent steps to the -wal file first, so it can be newer than the database. An empty one holds nothing new. */
function antigravityUpdatedAt(path: string): string {
  const database = statSync(path).mtime;
  const wal = existsSync(`${path}-wal`) ? statSync(`${path}-wal`) : undefined;
  return (wal?.size && wal.mtime > database ? wal.mtime : database).toISOString();
}

function antigravityId(path: string): string {
  return basename(path).replace(/\.db$/i, "");
}

function fileUriToPath(uri: string): string | undefined {
  if (!uri) return undefined;
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  } catch {
    return undefined;
  }
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
  // Only Gemini writes a whole session as one JSON document, and only Antigravity keeps one in SQLite.
  if (/\.json$/i.test(path)) return "gemini";
  if (/\.db$/i.test(path)) return "antigravity";
  for (const line of readHead(path, 64_000).split(/\r?\n/).slice(0, 10)) {
    const record = objectValue(parseJson(line));
    if (record.type === "session_meta" || "payload" in record) return "codex";
    if ("projectHash" in record || "$set" in record || "$rewindTo" in record) return "gemini";
    if ("sessionId" in record || "message" in record) return "claude";
  }
  if (path.includes(join(".gemini", "tmp"))) return "gemini";
  return path.includes(`${join(".claude", "projects")}`) ? "claude" : "codex";
}

function listDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
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

export function parseGeminiSession(path: string, budget = DEFAULT_EXCERPT_TOKENS): SourceSession {
  const { metadata, messages, lineCount } = readGeminiConversation(path);
  const builder = new SessionBuilder();
  const id = stringValue(metadata.sessionId) || sessionIdFromPath(path);
  const projectDir = geminiProjectDir(path);

  for (const message of messages) {
    const timestamp = stringValue(message.timestamp) || undefined;
    if (message.type === "user") {
      builder.message("user", geminiUserPrompt(message), timestamp);
    } else if (message.type === "gemini") {
      builder.message("assistant", geminiText(message.content), timestamp);
      for (const call of Array.isArray(message.toolCalls) ? message.toolCalls.map(objectValue) : []) {
        readGeminiTool(builder, call, timestamp, projectDir ? join(projectDir, id, "plans") : undefined);
      }
    }
    // info, warning, and error records are CLI notices, not conversation.
  }

  return buildSession({
    source: "gemini",
    id,
    path,
    cwd: projectDir ? readGeminiProjectRoot(projectDir) : undefined,
    lineCount,
    builder,
    budget,
    threadName: stringValue(metadata.summary) || undefined
  });
}

/**
 * Replays a Gemini chat file the way Gemini CLI loads it: a message record is rewritten in place each time its id
 * repeats, `$set` updates metadata (or replaces every message), and `$rewindTo` drops that message and all after it.
 */
function readGeminiConversation(path: string): { metadata: Record<string, unknown>; messages: Record<string, unknown>[]; lineCount: number } {
  if (/\.json$/i.test(path)) {
    const record = objectValue(parseJson(readFileSync(path, "utf8")));
    const messages = Array.isArray(record.messages) ? record.messages.map(objectValue) : [];
    return { metadata: record, messages, lineCount: messages.length };
  }

  const lines = readSessionLines(path);
  const messages = new Map<string, Record<string, unknown>>();
  const addMessages = (value: unknown) => {
    for (const message of Array.isArray(value) ? value.map(objectValue) : []) if (typeof message.id === "string") messages.set(message.id, message);
  };
  let metadata: Record<string, unknown> = {};
  for (const line of lines) {
    const record = objectValue(parseJson(line));
    if (typeof record.$rewindTo === "string") {
      const ids = [...messages.keys()];
      const index = ids.indexOf(record.$rewindTo);
      for (const messageId of index >= 0 ? ids.slice(index) : ids) messages.delete(messageId);
    } else if (typeof record.id === "string") {
      messages.set(record.id, record);
    } else if (record.$set && typeof record.$set === "object") {
      const update = objectValue(record.$set);
      if (Array.isArray(update.messages)) {
        messages.clear();
        addMessages(update.messages);
      }
      metadata = { ...metadata, ...update };
    } else if (typeof record.sessionId === "string") {
      metadata = { ...metadata, ...record };
      addMessages(record.messages);
    }
  }
  return { metadata, messages: [...messages.values()], lineCount: lines.length };
}

const GEMINI_REFERENCED_FILES = "--- Content from referenced files ---";

/** What the user typed. `displayContent` holds it when `@file` expansion rewrote `content`; tool results carry no text. */
function geminiUserPrompt(message: Record<string, unknown>): string {
  if (message.type !== "user") return "";
  const text = geminiText(message.displayContent ?? message.content).split(GEMINI_REFERENCED_FILES)[0];
  return cleanText(text);
}

function geminiText(value: unknown): string {
  if (typeof value === "string") return value;
  const parts = Array.isArray(value) ? value.map(objectValue) : [objectValue(value)];
  return parts
    .filter((part) => typeof part.text === "string" && part.thought !== true)
    .map((part) => part.text as string)
    .join("");
}

function readGeminiTool(builder: SessionBuilder, call: Record<string, unknown>, messageTimestamp?: string, plansDir?: string): void {
  const name = stringValue(call.name);
  const args = objectValue(call.args);
  const status = stringValue(call.status);
  const timestamp = stringValue(call.timestamp) || messageTimestamp;

  switch (name) {
    case "run_shell_command": {
      const command = stringValue(args.command);
      if (status === "cancelled") {
        builder.toolCall("Shell", `${command} (cancelled)`, timestamp);
        return;
      }
      const output = geminiToolOutput(call);
      const background = args.is_background === true || output.startsWith("Command moved to background");
      // The shell tool appends "Exit Code: N" only when N is non-zero.
      const exitCode = parseExitCode(output) ?? (status === "error" ? 1 : status === "success" && !background ? 0 : undefined);
      builder.command(command, exitCode, output, timestamp);
      return;
    }
    case "replace":
    case "write_file":
      if (status !== "error" && status !== "cancelled") builder.edit(stringValue(args.file_path), timestamp);
      return;
    case "write_todos":
      builder.setPlan(planItemsFrom(args.todos));
      return;
    case "exit_plan_mode": {
      const planFile = plansDir && stringValue(args.plan_filename) ? join(plansDir, basename(stringValue(args.plan_filename))) : "";
      if (planFile && existsSync(planFile)) builder.planText = cleanText(readFileSync(planFile, "utf8"));
      return;
    }
  }
  const detail = stringValue(args.file_path) || stringValue(args.dir_path) || stringValue(args.pattern) || stringValue(args.query) || stringValue(args.url) || stringValue(args.description);
  builder.toolCall(name, detail, timestamp);
}

/** The text a tool returned to the model. The shell tool prefixes the command's output with "Output: ". */
function geminiToolOutput(call: Record<string, unknown>): string {
  const texts = (Array.isArray(call.result) ? call.result.map(objectValue) : [])
    .flatMap((part) => {
      const response = objectValue(objectValue(part.functionResponse).response);
      return [stringValue(response.output), stringValue(response.error), stringValue(part.text)];
    })
    .filter(Boolean);
  const text = texts.length ? texts.join("\n") : stringValue(call.resultDisplay);
  return text.replace(/^Output: /, "");
}

// Field numbers below come from the protos agy embeds: gemini_coder.Step and the exa.cortex_pb step payloads.
const AGY_STEP = { userInput: 14, plannerResponse: 15, errorMessage: 17, checkpoint: 23, commandStatus: 28 } as const;
const AGY_STATUS = { cleared: 5, canceled: 6, error: 7 } as const;
const AGY_EDIT_TOOLS = new Set(["replace_file_content", "multi_replace_file_content", "write_to_file"]);

export function parseAntigravitySession(path: string, budget = DEFAULT_EXCERPT_TOKENS): SourceSession {
  const db = openAntigravityDb(path);
  if (!db) throw new CtxError(`Could not open the Antigravity conversation ${path}.`, "Check that the file exists and is readable.");
  const builder = new SessionBuilder();
  const id = antigravityId(path);
  let metadata: AntigravitySummary = {};
  let stepCount = 0;
  let checkpointTitle: string | undefined;
  try {
    metadata = antigravityTrajectoryMetadata(db);
    for (const row of db.prepare("SELECT step_payload FROM steps ORDER BY idx").all()) {
      if (!(row.step_payload instanceof Uint8Array)) continue;
      stepCount++;
      checkpointTitle = readAntigravityStep(builder, pbDecode(row.step_payload)) || checkpointTitle;
    }
  } finally {
    db.close();
  }
  const summary = readAntigravityIndex().get(id);
  const firstPrompt = builder.transcript.find((entry) => entry.role === "user")?.text;
  return buildSession({
    source: "antigravity",
    id,
    path,
    cwd: metadata.cwd || summary?.cwd,
    lineCount: stepCount,
    builder,
    budget,
    threadName: summary?.title || checkpointTitle || (firstPrompt ? truncate(oneLine(firstPrompt), 80) : undefined)
  });
}

/** Feeds one gemini_coder.Step into the builder; returns a conversation title when a checkpoint carries one. */
function readAntigravityStep(builder: SessionBuilder, step: PbMessage): string | undefined {
  const type = pbInt(step, 1);
  const status = pbInt(step, 4);
  const metadata = pbMessage(step, 5);
  const timestamp = pbTimestamp(pbMessage(metadata, 1));

  // Steps that Antigravity has compacted out of context keep their metadata but lose their payload, so old
  // prompts and replies come back empty here; the latest checkpoint summarizes them.
  switch (type) {
    case AGY_STEP.userInput:
      builder.message("user", antigravityPrompt(pbMessage(step, 19)), timestamp);
      return undefined;
    case AGY_STEP.plannerResponse: {
      const response = pbMessage(step, 20);
      builder.message("assistant", pbString(response, 8) || pbString(response, 1), timestamp);
      return undefined;
    }
    case AGY_STEP.checkpoint: {
      const checkpoint = pbMessage(step, 30);
      const summary = pbString(checkpoint, 5);
      if (summary.trim()) builder.compactSummary = cleanText(summary);
      return pbString(checkpoint, 10) || undefined;
    }
    case AGY_STEP.commandStatus: {
      const result = pbMessage(step, 37);
      builder.commandResult(pbString(result, 1), pbString(result, 9) || pbString(result, 3), { exitCode: pbInt(result, 5) });
      return undefined;
    }
    case AGY_STEP.errorMessage:
      // The tool call failed before it ran.
      return undefined;
  }

  const call = pbMessage(metadata, 4);
  const name = pbString(call, 2);
  // System and ephemeral messages carry no tool call.
  if (name) readAntigravityTool(builder, name, objectValue(parseJson(pbString(call, 3))), step, status, timestamp);
  return undefined;
}

/** CortexStepUserInput: what the user sent (2), else its text items (3), else the raw query (1). */
function antigravityPrompt(input: PbMessage): string {
  return pbString(input, 2) || pbMessages(input, 3).map((item) => pbString(item, 1)).join("") || pbString(input, 1);
}

function readAntigravityTool(
  builder: SessionBuilder,
  name: string,
  args: Record<string, unknown>,
  step: PbMessage,
  status: number | undefined,
  timestamp?: string
): void {
  // Newer agy builds run every tool as a generic step (140) whose result carries the typed step as a google.protobuf.Any.
  const result = pbMessage(pbMessage(step, 140), 2);
  const resultText = pbString(result, 1);
  const payload = pbMessage(result, 6);
  const typed = pbString(payload, 1).endsWith("gemini_coder.Step") ? pbDecode(pbBytes(payload, 2)) : step;

  if (name === "run_command") {
    const run = pbMessage(typed, 28);
    const command = stringValue(args.CommandLine) || pbString(run, 23) || pbString(run, 1);
    if (status === AGY_STATUS.canceled || pbInt(run, 14) === 1 || /^Encountered error in step execution: context canceled/.test(resultText.trim())) {
      builder.toolCall("Shell", `${command} (cancelled)`, timestamp);
      return;
    }
    const exitCode = pbInt(run, 6) ?? numberFromMatch(/exited with code (-?\d+)/.exec(resultText)) ?? (status === AGY_STATUS.error ? 1 : undefined);
    const output = pbString(pbMessage(run, 21), 1) || resultText;
    const commandId = pbString(run, 13);
    // A command that went to the background reports its exit code in a later command_status step.
    if (exitCode === undefined && commandId && status !== AGY_STATUS.cleared) builder.commandCall(commandId, command, timestamp);
    else builder.command(command, exitCode, output, timestamp);
    return;
  }
  if (AGY_EDIT_TOOLS.has(name)) {
    const file = stringValue(args.TargetFile);
    // Plans and walkthroughs that agy writes to its own brain folder are not repo edits.
    if (file && status !== AGY_STATUS.canceled && status !== AGY_STATUS.error && !isInside(resolve(file), resolve(antigravityHome()))) builder.edit(file, timestamp);
    return;
  }
  const detail =
    stringValue(args.AbsolutePath) || stringValue(args.DirectoryPath) || stringValue(args.SearchPath) || stringValue(args.Query) || stringValue(args.query) || stringValue(args.Url);
  builder.toolCall(name, detail, timestamp);
}

function numberFromMatch(match: RegExpExecArray | null): number | undefined {
  return match ? Number(match[1]) : undefined;
}

const requireBuiltin = createRequire(import.meta.url);
let sqliteModule: typeof import("node:sqlite") | undefined;

/** node:sqlite prints an ExperimentalWarning on load in Node 22; keep CLI output clean. */
function loadSqlite(): typeof import("node:sqlite") {
  if (sqliteModule) return sqliteModule;
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(message)) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqliteModule = requireBuiltin("node:sqlite") as typeof import("node:sqlite");
    return sqliteModule;
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Opens an Antigravity database without changing anything next to it. A running agy keeps its newest steps in the
 * -wal file, so read through it while agy has it open. Otherwise open the file as immutable: a plain read-only open
 * of a WAL database would create -wal and -shm files in agy's folder.
 */
function openAntigravityDb(path: string): DatabaseSync | undefined {
  if (!existsSync(path)) return undefined;
  const { DatabaseSync } = loadSqlite();
  if (existsSync(`${path}-wal`) && existsSync(`${path}-shm`)) {
    try {
      return new DatabaseSync(path, { readOnly: true });
    } catch {
      // Fall back to the last checkpointed state.
    }
  }
  try {
    const url = pathToFileURL(path);
    url.searchParams.set("immutable", "1");
    return new DatabaseSync(url, { readOnly: true });
  } catch {
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
  "session_context",
  "hook_context",
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
      text: oneLine(stringValue(entry.content) || stringValue(entry.step) || stringValue(entry.text) || stringValue(entry.subject) || stringValue(entry.description)),
      status: planStatus(entry.status)
    }))
    .filter((entry) => entry.text && entry.status !== undefined) as PlanItem[];
}

function planStatus(value: unknown): PlanStatus | undefined {
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "in-progress" || value === "active") return "in_progress";
  if (value === "pending" || value === "todo" || value === "not_started" || value === "blocked") return "pending";
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
// Protobuf wire format, enough to read Antigravity's stored steps without its schema files

type PbMessage = Map<number, (bigint | Uint8Array)[]>;

const utf8 = new TextDecoder();

/** One level of a serialized message. Nested messages stay as bytes until asked for; a malformed tail is dropped. */
function pbDecode(bytes: Uint8Array | undefined): PbMessage {
  const fields: PbMessage = new Map();
  if (!bytes) return fields;
  let offset = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; offset < bytes.length; shift += 7n) {
      const byte = bytes[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
    throw new Error("truncated varint");
  };
  try {
    while (offset < bytes.length) {
      const key = varint();
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      let value: bigint | Uint8Array;
      if (wire === 0) {
        value = varint();
      } else if (wire === 2) {
        const length = Number(varint());
        if (offset + length > bytes.length) break;
        value = bytes.subarray(offset, offset + length);
        offset += length;
      } else if (wire === 1 || wire === 5) {
        offset += wire === 1 ? 8 : 4;
        continue;
      } else {
        break;
      }
      const values = fields.get(field);
      if (values) values.push(value);
      else fields.set(field, [value]);
    }
  } catch {
    // Keep the fields read so far.
  }
  return fields;
}

function pbBytes(message: PbMessage, field: number): Uint8Array | undefined {
  const value = message.get(field)?.at(-1);
  return value instanceof Uint8Array ? value : undefined;
}

function pbString(message: PbMessage, field: number): string {
  const bytes = pbBytes(message, field);
  return bytes ? utf8.decode(bytes) : "";
}

function pbMessage(message: PbMessage, field: number): PbMessage {
  return pbDecode(pbBytes(message, field));
}

function pbMessages(message: PbMessage, field: number): PbMessage[] {
  return (message.get(field) || []).filter((value): value is Uint8Array => value instanceof Uint8Array).map(pbDecode);
}

/** An int32/enum/bool field; undefined when absent. */
function pbInt(message: PbMessage, field: number): number | undefined {
  const value = message.get(field)?.at(-1);
  return typeof value === "bigint" ? Number(BigInt.asIntN(32, value)) : undefined;
}

/** A google.protobuf.Timestamp as an ISO string. */
function pbTimestamp(timestamp: PbMessage): string | undefined {
  const seconds = timestamp.get(1)?.at(-1);
  if (typeof seconds !== "bigint") return undefined;
  const nanos = timestamp.get(2)?.at(-1);
  return new Date(Number(seconds) * 1000 + (typeof nanos === "bigint" ? Number(nanos) / 1e6 : 0)).toISOString();
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
