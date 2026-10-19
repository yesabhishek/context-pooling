import { basename } from "node:path";
import type { FileChange, FileChangeStatus, GitSnapshot } from "./types.js";
import { isSensitivePath, redactSecrets } from "./redact.js";
import { limit, runOptional, slugify } from "./util.js";

const MAX_DIFF_PATCH_CHARS = 120_000;
const MAX_FILE_CHANGES = 200;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_FLAGS = ["-c", "core.quotePath=false", "-c", "color.ui=never"];

function git(args: string[], cwd: string): string {
  return runOptional("git", [...GIT_FLAGS, ...args], cwd);
}

export function gitTopLevel(cwd = process.cwd()): string | undefined {
  return git(["rev-parse", "--show-toplevel"], cwd).trim() || undefined;
}

export function captureGitSnapshot(cwd = process.cwd()): GitSnapshot {
  const topLevel = gitTopLevel(cwd);
  if (!topLevel) {
    return {
      repoPath: cwd,
      isGitRepo: false,
      branch: "no-git",
      commit: "unknown",
      dirtyFiles: [],
      fileChanges: [],
      diffStat: "",
      diffPatch: "",
      diffPatchTruncated: false,
      recentCommits: []
    };
  }

  const repoPath = topLevel;
  const hasHead = Boolean(git(["rev-parse", "--verify", "--quiet", "HEAD"], repoPath).trim());
  const base = hasHead ? "HEAD" : EMPTY_TREE;
  const branch = git(["branch", "--show-current"], repoPath).trim() || (hasHead ? "detached" : "unborn");
  const commit = hasHead ? git(["rev-parse", "--short", "HEAD"], repoPath).trim() : "none";
  const status = git(["status", "--porcelain=v1", "-z"], repoPath);
  const numstat = git(["diff", base, "--numstat", "-z", "--no-ext-diff"], repoPath);
  const fileChanges = parseFileChanges(status, numstat).slice(0, MAX_FILE_CHANGES);
  const patch = buildPatch(git(["diff", base, "--no-ext-diff", "--unified=3"], repoPath));

  return {
    repoPath,
    isGitRepo: true,
    branch,
    commit,
    dirtyFiles: limit(
      fileChanges.map((change) => change.path),
      40
    ),
    fileChanges,
    diffStat: git(["diff", base, "--shortstat", "--no-ext-diff"], repoPath).trim(),
    diffPatch: patch.patch,
    diffPatchTruncated: patch.truncated,
    recentCommits: limit(git(["log", "--oneline", "-5"], repoPath).split("\n"), 5)
  };
}

const BRANCH_PREFIX = /^(?:feature|feat|fix|bugfix|hotfix|chore|task|refactor|docs|claude|codex|cursor|agent)\//;
const TRUNK_BRANCHES = ["main", "master", "develop", "dev", "trunk", "detached", "unborn", "no-git"];

export function inferTaskName(explicitTask: string | undefined, repo: GitSnapshot): string {
  if (explicitTask) return slugify(explicitTask);
  const branch = repo.branch.trim();
  if (branch && !TRUNK_BRANCHES.includes(branch)) return slugify(branch.replace(BRANCH_PREFIX, ""));
  return slugify(basename(repo.repoPath));
}

/**
 * Parse `git status --porcelain=v1` output into file changes. Accepts NUL-separated (-z) or
 * newline-separated output; numstat may be in either form too.
 */
export function parseFileChanges(statusOutput: string, numstatOutput = ""): FileChange[] {
  const stats = parseNumstat(numstatOutput);
  const changes: FileChange[] = [];
  const nulSeparated = statusOutput.includes("\0");
  const entries = nulSeparated ? statusOutput.split("\0") : statusOutput.split("\n");

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    let path = entry.slice(3);
    let oldPath: string | undefined;
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      if (nulSeparated) {
        oldPath = entries[++index];
      } else if (path.includes(" -> ")) {
        [oldPath, path] = path.split(" -> ", 2);
      }
    }
    const stat = stats.get(path) || (oldPath ? stats.get(oldPath) : undefined) || { additions: 0, deletions: 0 };
    changes.push({
      path,
      oldPath,
      status: mapStatus(indexStatus, worktreeStatus, Boolean(oldPath)),
      indexStatus: indexStatus.trim() || undefined,
      worktreeStatus: worktreeStatus.trim() || undefined,
      additions: stat.additions,
      deletions: stat.deletions,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: worktreeStatus !== " " && worktreeStatus !== "?",
      untracked: indexStatus === "?" && worktreeStatus === "?"
    });
  }
  return changes;
}

function mapStatus(indexStatus: string, worktreeStatus: string, renamed: boolean): FileChangeStatus {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (renamed || indexStatus === "R" || worktreeStatus === "R") return "renamed";
  if (indexStatus === "C" || worktreeStatus === "C") return "copied";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus === "M" || worktreeStatus === "M" || indexStatus === "T" || worktreeStatus === "T") return "modified";
  return "unknown";
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const count = (value: string) => (value === "-" ? 0 : Number(value) || 0);

  if (output.includes("\0")) {
    const parts = output.split("\0");
    for (let index = 0; index < parts.length; index++) {
      const fields = parts[index].replace(/^\n/, "").split("\t");
      if (fields.length < 3) continue;
      const stat = { additions: count(fields[0]), deletions: count(fields[1]) };
      // Renames: "added\tdeleted\t" followed by the old and new paths as separate entries.
      const path = fields[2] || (index += 2, parts[index]);
      if (path) stats.set(path, stat);
    }
    return stats;
  }

  for (const line of output.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const path = expandRenamePath(fields.slice(2).join("\t"));
    if (path) stats.set(path, { additions: count(fields[0]), deletions: count(fields[1]) });
  }
  return stats;
}

/** `src/{old => new}/file.ts` -> `src/new/file.ts`; `old.ts => new.ts` -> `new.ts`. */
function expandRenamePath(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\//g, "/").trim();
  const plain = /^(.*) => (.*)$/.exec(path);
  return (plain ? plain[2] : path).trim();
}

/** Redact secrets and drop the bodies of sensitive files (.env, keys) before the patch is stored. */
function buildPatch(raw: string): { patch: string; truncated: boolean } {
  const sections = raw.split(/(?=^diff --git )/m).map((section) => {
    const path = /^diff --git a\/.+ b\/(.+)$/m.exec(section)?.[1] || "";
    if (!isSensitivePath(path)) return section;
    return `${section.split("\n")[0]}\n[ContextPool: diff omitted for sensitive file]\n`;
  });
  const patch = redactSecrets(sections.join(""));
  const truncated = patch.length > MAX_DIFF_PATCH_CHARS;
  return {
    patch: truncated ? `${patch.slice(0, MAX_DIFF_PATCH_CHARS)}\n\n[ContextPool: diff truncated at ${MAX_DIFF_PATCH_CHARS} characters]` : patch,
    truncated
  };
}
