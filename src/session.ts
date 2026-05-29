import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SourceAgent, SourceSession, TranscriptEntry } from "./types.js";
import { findRecentFiles, limit, unique } from "./util.js";

export type SessionFrom = "auto" | SourceAgent;

export type ResolveSessionOptions = {
  from?: SessionFrom;
  cwd: string;
  session?: string;
  budget?: number;
};

type SessionCandidate = {
  source: SourceAgent;
  path: string;
  id: string;
  cwd?: string;
  updatedAt: string;
  matchedCwd: boolean;
  threadName?: string;
};

export function resolveSessionSource(options: ResolveSessionOptions): SourceSession {
  const from = normalizeFrom(options.from || "auto");
  const cwd = resolve(options.cwd);

  if (options.session) {
    return resolveExplicitSession(from, cwd, options.session, options.budget);
  }

  if (from === "codex") return parseCandidate(requiredBest(findCodexCandidates(cwd), "codex", cwd), options.budget);
  if (from === "claude") return parseCandidate(requiredBest(findClaudeCandidates(cwd), "claude", cwd), options.budget);

  const candidates = [...findCodexCandidates(cwd), ...findClaudeCandidates(cwd)]
    .sort(compareCandidates);

  if (candidates.length === 0) {
    throw new Error("No Codex or Claude session files were found. Pass --from and --session with a JSONL path.");
  }

  const [first, second] = candidates;
  if (
    first &&
    second &&
    first.matchedCwd &&
    second.matchedCwd &&
    first.source !== second.source &&
    Math.abs(Date.parse(first.updatedAt) - Date.parse(second.updatedAt)) < 10 * 60 * 1000
  ) {
    throw new Error(
      `Both Codex and Claude have recent sessions for this workspace. Re-run with --from ${first.source} or --from ${second.source}.`
    );
  }

  return parseCandidate(first, options.budget);
}

function normalizeFrom(from: string): SessionFrom {
  if (from === "auto" || from === "codex" || from === "claude") return from;
  throw new Error(`Unsupported --from value "${from}". Use auto, codex, or claude.`);
}

export function parseCodexSession(path: string, budget = 12_000): SourceSession {
  const lines = readSessionLines(path);
  const transcript: TranscriptEntry[] = [];
  let id = sessionIdFromPath(path);
  let cwd: string | undefined;
  let updatedAt = statSync(path).mtime.toISOString();

  for (const line of lines) {
    const item = parseJson(line);
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = stringValue(record.type);

    if (type === "session_meta") {
      const payload = objectValue(record.payload);
      id = stringValue(payload.id) || id;
      cwd = stringValue(payload.cwd) || cwd;
      updatedAt = stringValue(payload.timestamp) || updatedAt;
      continue;
    }

    const timestamp = stringValue(record.timestamp) || stringValue(objectValue(record.payload).timestamp);

    if (type === "event_msg") {
      const payload = objectValue(record.payload);
      const payloadType = stringValue(payload.type);
      if (payloadType === "user_message") pushEntry(transcript, "user", stringValue(payload.message), timestamp, "message");
      if (payloadType === "agent_message") pushEntry(transcript, "assistant", stringValue(payload.message), timestamp, "message");
      continue;
    }

    if (type === "response_item") {
      const payload = objectValue(record.payload);
      const itemType = stringValue(payload.type);
      if (itemType === "message") {
        const role = stringValue(payload.role) === "user" ? "user" : "assistant";
        pushEntry(transcript, role, collectText(payload.content).join("\n"), timestamp, "message");
      } else if (itemType === "function_call") {
        const name = stringValue(payload.name) || "tool_call";
        pushEntry(transcript, "tool", `${name} ${stringValue(payload.arguments)}`.trim(), timestamp, "tool_call");
      } else if (itemType === "function_call_output") {
        pushEntry(transcript, "tool", stringValue(payload.output), timestamp, "tool_output");
      }
    }
  }

  return buildSession({
    source: "codex",
    id,
    path,
    cwd,
    updatedAt,
    matchedCwd: false,
    lineCount: lines.length,
    transcript,
    budget
  });
}

export function parseClaudeSession(path: string, budget = 12_000): SourceSession {
  const lines = readSessionLines(path);
  const transcript: TranscriptEntry[] = [];
  let id = sessionIdFromPath(path);
  let cwd: string | undefined;
  let updatedAt = statSync(path).mtime.toISOString();

  for (const line of lines) {
    const item = parseJson(line);
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.isMeta === true) continue;

    id = stringValue(record.sessionId) || id;
    cwd = stringValue(record.cwd) || cwd;
    const timestamp = stringValue(record.timestamp);
    updatedAt = timestamp || updatedAt;

    const type = stringValue(record.type);
    const message = objectValue(record.message);
    if (message.role || message.content) {
      const role = stringValue(message.role) === "assistant" ? "assistant" : stringValue(message.role) === "user" ? "user" : "system";
      pushEntry(transcript, role, collectText(message.content).join("\n"), timestamp, "message");
      continue;
    }

    if (type === "system" || stringValue(record.subtype) === "local_command") {
      pushEntry(transcript, "tool", collectText(record.content).join("\n"), timestamp, stringValue(record.subtype) || "system");
    }
  }

  return buildSession({
    source: "claude",
    id,
    path,
    cwd,
    updatedAt,
    matchedCwd: false,
    lineCount: lines.length,
    transcript,
    budget,
    supplementalPaths: latestClaudeSupplementalPaths()
  });
}

function resolveExplicitSession(from: SessionFrom, cwd: string, session: string, budget?: number): SourceSession {
  if (existsSync(session)) {
    const source = from === "auto" ? inferSourceFromPath(session) : from;
    if (source === "claude") return parseWithMatch(parseClaudeSession(session, budget), cwd);
    return parseWithMatch(parseCodexSession(session, budget), cwd);
  }

  if (from === "claude") {
    throw new Error("--session for Claude must be a JSONL path.");
  }

  const match = findRecentFiles(join(homedir(), ".codex", "sessions"), 500)
    .find((path) => path.includes(session));
  if (!match) throw new Error(`No Codex session file matched "${session}". Pass a JSONL path instead.`);
  return parseWithMatch(parseCodexSession(match, budget), cwd);
}

function findCodexCandidates(cwd: string): SessionCandidate[] {
  const paths = findRecentFiles(join(homedir(), ".codex", "sessions"), 300)
    .filter((path) => path.endsWith(".jsonl"));
  const index = readCodexIndex();
  return paths.map((path) => {
    const meta = readCodexMeta(path);
    const id = meta.id || sessionIdFromPath(path);
    return {
      source: "codex" as const,
      path,
      id,
      cwd: meta.cwd,
      updatedAt: meta.updatedAt || statSync(path).mtime.toISOString(),
      matchedCwd: samePath(meta.cwd, cwd),
      threadName: index.get(id)
    };
  }).sort(compareCandidates);
}

function findClaudeCandidates(cwd: string): SessionCandidate[] {
  const encoded = encodeClaudeProjectPath(cwd);
  const preferred = join(homedir(), ".claude", "projects", encoded);
  const roots = existsSync(preferred) ? [preferred] : [join(homedir(), ".claude", "projects")];
  return roots
    .flatMap((root) => findRecentFiles(root, 300))
    .filter((path) => path.endsWith(".jsonl"))
    .map((path) => {
      const meta = readClaudeMeta(path);
      return {
        source: "claude" as const,
        path,
        id: meta.id || sessionIdFromPath(path),
        cwd: meta.cwd,
        updatedAt: meta.updatedAt || statSync(path).mtime.toISOString(),
        matchedCwd: samePath(meta.cwd, cwd)
      };
    })
    .sort(compareCandidates);
}

function parseCandidate(candidate: SessionCandidate, budget?: number): SourceSession {
  const session = candidate.source === "codex" ? parseCodexSession(candidate.path, budget) : parseClaudeSession(candidate.path, budget);
  session.id = candidate.id || session.id;
  session.cwd = candidate.cwd || session.cwd;
  session.updatedAt = candidate.updatedAt || session.updatedAt;
  session.matchedCwd = candidate.matchedCwd;
  session.threadName = candidate.threadName || session.threadName;
  return session;
}

function requiredBest(candidates: SessionCandidate[], source: SourceAgent, cwd: string): SessionCandidate {
  const best = candidates[0];
  if (!best) throw new Error(`No ${source} sessions were found for ${cwd}. Pass --session with a JSONL path.`);
  return best;
}

function compareCandidates(a: SessionCandidate, b: SessionCandidate): number {
  if (a.matchedCwd !== b.matchedCwd) return a.matchedCwd ? -1 : 1;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function buildSession(args: {
  source: SourceAgent;
  id: string;
  path: string;
  cwd?: string;
  updatedAt: string;
  matchedCwd: boolean;
  lineCount: number;
  transcript: TranscriptEntry[];
  budget?: number;
  supplementalPaths?: string[];
}): SourceSession {
  const transcript = args.transcript.filter((entry) => isUsefulText(entry.text));
  return {
    source: args.source,
    id: args.id,
    path: args.path,
    cwd: args.cwd,
    updatedAt: args.updatedAt,
    matchedCwd: args.matchedCwd,
    lineCount: args.lineCount,
    transcript,
    transcriptExcerpt: renderTranscriptExcerpt(transcript, args.budget || 12_000),
    supplementalPaths: args.supplementalPaths
  };
}

function renderTranscriptExcerpt(entries: TranscriptEntry[], budget: number): string {
  const rendered = entries.slice(-80).map((entry) => {
    const when = entry.timestamp ? ` ${entry.timestamp}` : "";
    const kind = entry.kind ? `/${entry.kind}` : "";
    return `### ${entry.role}${kind}${when}\n${entry.text}`;
  });

  let output = rendered.join("\n\n").trim();
  if (output.length > budget) output = output.slice(output.length - budget).replace(/^[\s\S]*?(?=### )/, "");
  return output || "No transcript excerpt captured.";
}

function readCodexMeta(path: string): { id?: string; cwd?: string; updatedAt?: string } {
  for (const line of readHeadLines(path).slice(0, 20)) {
    const item = parseJson(line);
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (stringValue(record.type) !== "session_meta") continue;
    const payload = objectValue(record.payload);
    return {
      id: stringValue(payload.id),
      cwd: stringValue(payload.cwd),
      updatedAt: stringValue(payload.timestamp)
    };
  }
  return {};
}

function readClaudeMeta(path: string): { id?: string; cwd?: string; updatedAt?: string } {
  for (const line of readHeadLines(path).slice(0, 30)) {
    const item = parseJson(line);
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const cwd = stringValue(record.cwd);
    if (!cwd) continue;
    return {
      id: stringValue(record.sessionId),
      cwd,
      updatedAt: stringValue(record.timestamp)
    };
  }
  return {};
}

function readCodexIndex(): Map<string, string> {
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  const map = new Map<string, string>();
  if (!existsSync(indexPath)) return map;
  for (const line of readLines(indexPath)) {
    const item = parseJson(line);
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = stringValue(record.id);
    const name = stringValue(record.thread_name);
    if (id && name) map.set(id, name);
  }
  return map;
}

function latestClaudeSupplementalPaths(): string[] {
  return unique([
    ...findRecentFiles(join(homedir(), ".claude", "plans"), 5).filter((path) => path.endsWith(".md")),
    ...findRecentFiles(join(homedir(), ".claude", "tasks"), 5).filter((path) => path.endsWith(".json"))
  ]).slice(0, 8);
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
}

function readHeadLines(path: string): string[] {
  const stats = statSync(path);
  if (stats.size <= 256_000) return readLines(path);
  return readSlice(path, 0, 256_000).split(/\r?\n/).filter(Boolean);
}

function readSessionLines(path: string): string[] {
  const stats = statSync(path);
  if (stats.size <= 4_000_000) return readLines(path);
  const head = readSlice(path, 0, 512_000);
  const tailLength = Math.min(2_000_000, stats.size);
  const tail = readSlice(path, stats.size - tailLength, tailLength);
  return `${head}\n${tail}`.split(/\r?\n/).filter(Boolean);
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

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return ["text", "content", "message", "output", "error", "body", "name", "input"].flatMap((key) => collectText(record[key]));
}

function pushEntry(entries: TranscriptEntry[], role: TranscriptEntry["role"], text: string, timestamp?: string, kind?: string): void {
  const clean = cleanText(text);
  if (!isUsefulText(clean)) return;
  entries.push({ role, text: clean, timestamp, kind });
}

function cleanText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/g, "")
    .replace(/<app-context>[\s\S]*?<\/app-context>/g, "")
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/g, "")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, "")
    .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/g, "")
    .replace(/"encrypted_content":"[^"]+"/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isUsefulText(text: string): boolean {
  if (!text || text.length < 3) return false;
  if (text.includes("base_instructions")) return false;
  if (text.includes("Knowledge cutoff:")) return false;
  if (text.includes("You are Codex")) return false;
  if (text.includes("Filesystem sandboxing defines")) return false;
  if (text.includes("# Codex desktop context")) return false;
  if (text.includes("### Available skills")) return false;
  if (text.includes("### Skill roots")) return false;
  if (text.includes("Tool definitions")) return false;
  if (text.includes("Valid channels:")) return false;
  if (text.includes("# Handoff:")) return false;
  if (text.includes("DO NOT respond to these messages")) return false;
  if (text.includes("deferred_tools_delta")) return false;
  return true;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sessionIdFromPath(path: string): string {
  return basename(path).replace(/\.(jsonl|json)$/i, "").replace(/^rollout-[^-]+-[^-]+-[^-]+-/, "");
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a) return false;
  return resolve(a) === resolve(b);
}

function parseWithMatch(session: SourceSession, cwd: string): SourceSession {
  session.matchedCwd = samePath(session.cwd, cwd);
  return session;
}

function inferSourceFromPath(path: string): SourceAgent {
  return path.includes("/.claude/") ? "claude" : "codex";
}

function encodeClaudeProjectPath(cwd: string): string {
  return resolve(cwd).replace(/[\/\\]/g, "-");
}
