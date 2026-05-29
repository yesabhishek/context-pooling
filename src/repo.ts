import { basename } from "node:path";
import type { FileChange, FileChangeStatus, GitSnapshot } from "./types.js";
import { limit, runOptional, slugify, unique } from "./util.js";

const MAX_DIFF_PATCH_CHARS = 120_000;

export function captureGitSnapshot(cwd = process.cwd()): GitSnapshot {
  const topLevel = runOptional("git", ["rev-parse", "--show-toplevel"], cwd);
  const repoPath = topLevel || cwd;
  const isGitRepo = Boolean(topLevel);

  if (!isGitRepo) {
    return {
      repoPath,
      isGitRepo: false,
      branch: "no-git",
      commit: "unknown",
      dirtyFiles: [],
      fileChanges: [],
      diffStat: "",
      diffPatch: "",
      diffPatchTruncated: false,
      stagedDiffPatch: "",
      stagedDiffPatchTruncated: false,
      unstagedDiffPatch: "",
      unstagedDiffPatchTruncated: false,
      recentCommits: []
    };
  }

  const branch = runOptional("git", ["branch", "--show-current"], repoPath) || "detached";
  const commit = runOptional("git", ["rev-parse", "--short", "HEAD"], repoPath) || "unknown";
  const status = runOptional("git", ["status", "--porcelain=v1"], repoPath);
  const diffStat = runOptional("git", ["diff", "--stat"], repoPath);
  const allPatch = truncatePatch(runOptional("git", ["diff", "HEAD", "--no-ext-diff", "--unified=3"], repoPath));
  const stagedPatch = truncatePatch(runOptional("git", ["diff", "--cached", "--no-ext-diff", "--unified=3"], repoPath));
  const unstagedPatch = truncatePatch(runOptional("git", ["diff", "--no-ext-diff", "--unified=3"], repoPath));
  const numstat = runOptional("git", ["diff", "HEAD", "--numstat"], repoPath);
  const recent = runOptional("git", ["log", "--oneline", "-5"], repoPath);
  const fileChanges = parseFileChanges(status, numstat, allPatch.patch);

  return {
    repoPath,
    isGitRepo,
    branch,
    commit,
    dirtyFiles: limit(fileChanges.map((change) => change.path), 40),
    fileChanges: limitFileChanges(fileChanges, 120),
    diffStat,
    diffPatch: allPatch.patch,
    diffPatchTruncated: allPatch.truncated,
    stagedDiffPatch: stagedPatch.patch,
    stagedDiffPatchTruncated: stagedPatch.truncated,
    unstagedDiffPatch: unstagedPatch.patch,
    unstagedDiffPatchTruncated: unstagedPatch.truncated,
    recentCommits: limit(recent.split("\n"), 5)
  };
}

export function inferTaskName(explicitTask: string | undefined, repo: GitSnapshot): string {
  if (explicitTask) return slugify(explicitTask);
  const branch = repo.branch.trim();
  if (branch && !["main", "master", "develop", "dev", "trunk", "detached", "no-git"].includes(branch)) {
    return slugify(branch.replace(/^(feature|feat|fix|bugfix|chore|task)\//, ""));
  }
  return slugify(basename(repo.repoPath));
}

export function parseFileChanges(statusOutput: string, numstatOutput = "", patch = ""): FileChange[] {
  const stats = parseNumstat(numstatOutput);
  const diffs = splitPatchByFile(patch);
  return statusOutput
    .split("\n")
    .map((line) => parseStatusLine(line, stats, diffs))
    .filter((change): change is FileChange => Boolean(change));
}

function parseStatusLine(line: string, stats: Map<string, { additions: number; deletions: number }>, diffs: Map<string, string>): FileChange | undefined {
  if (!line.trim()) return undefined;
  const trimmedUnstaged = /^[MADRC] .+/.test(line) && line[2] !== " ";
  const indexStatus = trimmedUnstaged ? " " : line[0] || " ";
  const worktreeStatus = trimmedUnstaged ? line[0] : line[1] || " ";
  const rawPath = (trimmedUnstaged ? line.slice(2) : line.slice(3)).trim();
  if (!rawPath) return undefined;

  const renamed = rawPath.includes(" -> ");
  const [oldPath, currentPath] = renamed ? rawPath.split(" -> ", 2) : ["", rawPath];
  const path = currentPath || rawPath;
  const status = mapStatus(indexStatus, worktreeStatus, renamed);
  const stat = stats.get(path) || stats.get(oldPath) || { additions: 0, deletions: 0 };

  return {
    path,
    oldPath: oldPath || undefined,
    status,
    indexStatus: indexStatus.trim() || undefined,
    worktreeStatus: worktreeStatus.trim() || undefined,
    additions: stat.additions,
    deletions: stat.deletions,
    staged: indexStatus !== " " && indexStatus !== "?",
    unstaged: worktreeStatus !== " " && worktreeStatus !== "?",
    untracked: indexStatus === "?" && worktreeStatus === "?",
    diff: diffs.get(path) || diffs.get(oldPath)
  };
}

function mapStatus(indexStatus: string, worktreeStatus: string, renamed: boolean): FileChangeStatus {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (renamed || indexStatus === "R" || worktreeStatus === "R") return "renamed";
  if (indexStatus === "C" || worktreeStatus === "C") return "copied";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus === "M" || worktreeStatus === "M") return "modified";
  return "unknown";
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    const path = normalizeNumstatPath(parts.slice(2).join("\t"));
    if (path) stats.set(path, { additions, deletions });
  }
  return stats;
}

function normalizeNumstatPath(path: string): string {
  const renameMatch = path.match(/^(.*) => (.*)$/);
  if (!renameMatch) return path.trim();
  const [, before, after] = renameMatch;
  const prefix = before.includes("{") && after.includes("}") ? "" : "";
  return `${prefix}${after.replace(/[{}]/g, "")}`.trim();
}

function splitPatchByFile(patch: string): Map<string, string> {
  const chunks = new Map<string, string>();
  const lines = patch.split("\n");
  let currentPath = "";
  let current: string[] = [];
  const flush = () => {
    if (currentPath && current.length) chunks.set(currentPath, current.join("\n"));
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
      currentPath = parseDiffPath(line);
    } else if (current.length) {
      current.push(line);
    }
  }
  flush();
  return chunks;
}

function parseDiffPath(line: string): string {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match?.[2] || "";
}

function truncatePatch(value: string): { patch: string; truncated: boolean } {
  const truncated = value.length > MAX_DIFF_PATCH_CHARS;
  return {
    patch: truncated ? `${value.slice(0, MAX_DIFF_PATCH_CHARS)}\n\n[ContextPool: diff truncated at ${MAX_DIFF_PATCH_CHARS} characters]` : value,
    truncated
  };
}

function limitFileChanges(changes: FileChange[], count: number): FileChange[] {
  const seen = new Set<string>();
  const result: FileChange[] = [];
  for (const change of changes) {
    const key = `${change.status}:${change.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(change);
    if (result.length >= count) break;
  }
  return result;
}
