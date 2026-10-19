import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** An expected failure with an optional next step for the user. The CLI prints these without a stack trace. */
export class CtxError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "CtxError";
  }
}

export function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "current-task"
  );
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Run a command and return stdout, or "" on failure. Output is not trimmed so column-sensitive formats survive. */
export function runOptional(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
}

/** Resolve symlinks (e.g. macOS /var -> /private/var) so paths from git and from agent logs compare equal. */
export function canonicalPath(path: string): string {
  // Resolve the nearest existing ancestor; the path itself may be deleted or not yet created.
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    return resolve(path);
  }
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function limit(values: string[], count: number): string[] {
  return unique(values).slice(0, count);
}

/** Most recently modified files under `root`, newest first. */
export function findRecentFiles(root: string, maxFiles = 8, match = /\.(jsonl|json|md|txt|log)$/i, skipDirs: string[] = []): string[] {
  if (!existsSync(root)) return [];
  const skip = new Set(["node_modules", ".git", "dist", ...skipDirs]);
  const files: { path: string; mtimeMs: number }[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (!skip.has(entry)) stack.push(fullPath);
      } else if (match.test(entry)) {
        files.push({ path: fullPath, mtimeMs: stats.mtimeMs });
      }
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((file) => file.path);
}
