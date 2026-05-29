import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSignal } from "./types.js";
import { findRecentFiles, limit } from "./util.js";

const interestingLine = /(todo|plan|next|done|completed|block|blocked|error|failed|failure|fix|changed|created|updated|decision|decided|do not|don't|command|npm |pnpm |yarn |git |test)/i;

export function discoverAgentSignals(options: { latest?: boolean; codexPath?: string; claudePath?: string; maxAgeDays?: number } = {}): AgentSignal[] {
  const roots: { source: AgentSignal["source"]; path: string }[] = [
    { source: "codex", path: options.codexPath || join(homedir(), ".codex", "sessions") },
    { source: "claude", path: options.claudePath || join(homedir(), ".claude", "projects") }
  ];

  const signals: AgentSignal[] = [];
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    const files = findRecentFiles(root.path, options.latest ? 3 : 8);
    for (const path of files) {
      if (isTooOld(path, options.maxAgeDays ?? 14)) continue;
      const signal = readAgentSignal(root.source, path);
      if (signal.snippets.length > 0) signals.push(signal);
    }
  }

  return signals.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)).slice(0, options.latest ? 4 : 12);
}

export function readAgentSignal(source: AgentSignal["source"], path: string): AgentSignal {
  const stats = statSync(path);
  const raw = readFileSync(path, "utf8").slice(-180_000);
  const snippets = limit(extractInterestingSnippets(raw), 80);
  return {
    source,
    path,
    modifiedAt: stats.mtime.toISOString(),
    snippets
  };
}

export function extractInterestingSnippets(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .flatMap((line) => splitJsonLine(line))
    .map(cleanLine)
    .filter((line) => line.length > 8 && line.length < 900)
    .filter((line) => !line.includes("<local-command-caveat>"));

  return lines.filter((line) => interestingLine.test(line));
}

function isTooOld(path: string, maxAgeDays: number): boolean {
  if (maxAgeDays <= 0) return false;
  const ageMs = Date.now() - statSync(path).mtimeMs;
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

function splitJsonLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [trimmed];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return collectStrings(parsed);
  } catch {
    return [trimmed];
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const preferred = ["content", "text", "message", "summary", "command", "output", "error", "body"];
  return preferred.flatMap((key) => collectStrings(record[key]));
}

function cleanLine(line: string): string {
  return line
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
