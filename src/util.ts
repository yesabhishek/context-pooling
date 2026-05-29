import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "current-task";
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function runOptional(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function limit(values: string[], count: number): string[] {
  return unique(values).slice(0, count);
}

export function findRecentFiles(root: string, maxFiles = 8): string[] {
  if (!existsSync(root)) return [];
  const files: { path: string; mtimeMs: number }[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
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
        if (!["node_modules", ".git", "dist"].includes(entry)) stack.push(fullPath);
      } else if (/\.(jsonl|json|md|txt|log)$/i.test(entry)) {
        files.push({ path: fullPath, mtimeMs: stats.mtimeMs });
      }
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((file) => file.path);
}
