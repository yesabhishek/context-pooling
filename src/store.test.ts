import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "./store.js";
import type { HandoffPacket } from "./types.js";

describe("store", () => {
  it("reports empty status for a new local store", async () => {
    process.env.CTXPOOL_HOME = mkdtempSync(join(tmpdir(), "ctxpool-store-test-"));
    const store = await openStore();
    const status = store.getStatus();
    store.close();

    expect(status.handoffCount).toBe(0);
    expect(status.taskCount).toBe(0);
  });

  it("fetches a saved handoff by id", async () => {
    process.env.CTXPOOL_HOME = mkdtempSync(join(tmpdir(), "ctxpool-store-test-"));
    const store = await openStore();
    const packet: HandoffPacket = {
      id: "handoff-123",
      task: "billing-entitlements",
      createdAt: "2026-05-26T12:00:00.000Z",
      repo: {
        repoPath: "/tmp/repo",
        isGitRepo: true,
        branch: "main",
        commit: "abc1234",
        dirtyFiles: ["src/a.ts"],
        diffStat: "src/a.ts | 1 +",
        diffPatch: "diff --git a/src/a.ts b/src/a.ts",
        diffPatchTruncated: false,
        recentCommits: []
      },
      sources: [],
      sections: {
        goal: "goal",
        currentStatus: ["status"],
        completed: [],
        inProgress: [],
        todos: [],
        blockers: [],
        filesTouched: ["src/a.ts"],
        commandsRun: [],
        errors: [],
        decisions: [],
        doNotRepeat: [],
        nextBestAction: "next"
      },
      markdown: "# Handoff",
      markdownPath: "/tmp/handoff.md"
    };
    store.saveHandoff(packet);
    const found = store.getHandoffById("handoff-123");
    const missing = store.getHandoffById("does-not-exist");
    store.close();

    expect(found?.id).toBe("handoff-123");
    expect(found?.task).toBe("billing-entitlements");
    expect(missing).toBeUndefined();
  });
});
