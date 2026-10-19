import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureGitSnapshot, inferTaskName, parseFileChanges } from "./repo.js";
import { commitAll, gitRepo, tempDir } from "./test-helpers.js";

describe("parseFileChanges", () => {
  it("parses NUL-separated porcelain output, including renames", () => {
    const status = [" M src/ui.ts", "A  src/new.ts", "D  src/old.ts", "R  src/to.ts", "src/from.ts", "?? notes.md", ""].join("\0");
    const numstat = ["10\t2\tsrc/ui.ts", "4\t0\tsrc/new.ts", "0\t8\tsrc/old.ts", "3\t1\t", "src/from.ts", "src/to.ts", ""].join("\0");

    const changes = parseFileChanges(status, numstat);
    expect(changes.map((change) => [change.path, change.status])).toEqual([
      ["src/ui.ts", "modified"],
      ["src/new.ts", "added"],
      ["src/old.ts", "deleted"],
      ["src/to.ts", "renamed"],
      ["notes.md", "untracked"]
    ]);
    expect(changes[0]).toMatchObject({ additions: 10, deletions: 2, staged: false, unstaged: true });
    expect(changes[3]).toMatchObject({ oldPath: "src/from.ts", additions: 3, deletions: 1 });
  });

  it("keeps the leading space of an unstaged first entry", () => {
    expect(parseFileChanges(" M first.ts\0 M second.ts\0")).toMatchObject([
      { path: "first.ts", staged: false, unstaged: true },
      { path: "second.ts", staged: false, unstaged: true }
    ]);
  });

  it("expands braced rename paths in plain numstat output", () => {
    const [change] = parseFileChanges("R  src/old/file.ts -> src/new/file.ts", "2\t1\tsrc/{old => new}/file.ts");
    expect(change).toMatchObject({ path: "src/new/file.ts", oldPath: "src/old/file.ts", additions: 2, deletions: 1 });
  });
});

describe("captureGitSnapshot", () => {
  it("captures changes against HEAD", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "app.txt"), "hello\n");
    commitAll(repo);
    writeFileSync(join(repo, "app.txt"), "hello\nworld\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/new file.ts"), "x\n");

    const snapshot = captureGitSnapshot(repo);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.fileChanges).toMatchObject([
      { path: "app.txt", status: "modified", additions: 1, deletions: 0 },
      { path: "src/", status: "untracked" }
    ]);
    expect(snapshot.diffPatch).toContain("+world");
    expect(snapshot.diffStat).toContain("1 file changed");
  });

  it("works in a repository with no commits yet", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "a.ts"), "a\n");
    const snapshot = captureGitSnapshot(repo);
    expect(snapshot).toMatchObject({ isGitRepo: true, branch: "main", commit: "none" });
    expect(snapshot.fileChanges?.[0]).toMatchObject({ path: "a.ts", status: "untracked" });
  });

  it("handles folders that are not repositories", () => {
    expect(captureGitSnapshot(tempDir("plain"))).toMatchObject({ isGitRepo: false, fileChanges: [] });
  });
});

describe("inferTaskName", () => {
  const snapshot = (branch: string, repoPath = "/work/billing-service") => ({ ...captureGitSnapshot(tempDir("plain")), branch, repoPath });

  it("prefers an explicit name, then the branch, then the repo", () => {
    expect(inferTaskName("Billing Entitlements", snapshot("main"))).toBe("billing-entitlements");
    expect(inferTaskName(undefined, snapshot("feature/webhook-retries"))).toBe("webhook-retries");
    expect(inferTaskName(undefined, snapshot("claude/fix-login-a1b2"))).toBe("fix-login-a1b2");
    expect(inferTaskName(undefined, snapshot("main"))).toBe("billing-service");
  });
});
