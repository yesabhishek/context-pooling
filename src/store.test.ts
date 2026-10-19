import { describe, expect, it } from "vitest";
import { createContextPack } from "./pack.js";
import { openStore } from "./store.js";
import { isolateEnv } from "./test-helpers.js";
import type { HandoffPacket } from "./types.js";

function packet(id: string, task = "billing", createdAt = "2026-10-19T12:00:00.000Z"): HandoffPacket {
  return {
    id,
    task,
    createdAt,
    repo: { repoPath: "/tmp/repo", isGitRepo: true, branch: "main", commit: "abc1234", dirtyFiles: [], diffStat: "", diffPatch: "", diffPatchTruncated: false, recentCommits: [] },
    sources: [],
    sections: {
      goal: "",
      currentStatus: [],
      completed: [],
      inProgress: [],
      todos: [],
      blockers: [],
      filesTouched: [],
      commandsRun: [],
      errors: [],
      decisions: [],
      doNotRepeat: [],
      nextBestAction: "next"
    },
    markdown: `# Handoff: ${task}`,
    markdownPath: "/tmp/handoff.md"
  };
}

describe("store", () => {
  it("starts empty", async () => {
    isolateEnv();
    const store = await openStore();
    expect(store.getStatus()).toMatchObject({ handoffCount: 0, taskCount: 0, packCount: 0 });
    store.close();
  });

  it("saves and finds handoffs by id, task, and recency", async () => {
    isolateEnv();
    const store = await openStore();
    store.saveHandoff(packet("a", "billing", "2026-10-19T10:00:00.000Z"));
    store.saveHandoff(packet("b", "billing", "2026-10-19T11:00:00.000Z"));
    store.saveHandoff(packet("c", "search", "2026-10-19T09:00:00.000Z"));

    expect(store.getHandoffById("a")?.task).toBe("billing");
    expect(store.getHandoffById("missing")).toBeUndefined();
    expect(store.getLatestHandoff()?.id).toBe("b");
    expect(store.getLatestHandoff("search")?.id).toBe("c");
    expect(store.listTasks()).toMatchObject([
      { task: "billing", handoffCount: 2 },
      { task: "search", handoffCount: 1 }
    ]);
    expect(store.listRepoPaths()).toEqual(["/tmp/repo"]);
    store.close();
  });

  it("keeps writes from concurrent connections", async () => {
    isolateEnv();
    const ui = await openStore();
    const cli = await openStore();
    ui.listTasks();
    cli.saveHandoff(packet("from-cli"));
    ui.saveContextPack(createContextPack("From UI"));
    cli.close();
    ui.close();

    const check = await openStore();
    expect(check.getHandoffById("from-cli")).toBeDefined();
    expect(check.listContextPacks().map((pack) => pack.name)).toEqual(["From UI"]);
    check.close();
  });

  it("saves, lists, and deletes context packs", async () => {
    isolateEnv();
    const store = await openStore();
    const pack = store.saveContextPack(createContextPack("Saved pack"));
    expect(store.getContextPackById(pack.id)?.name).toBe("Saved pack");
    expect(store.deleteContextPack(pack.id)).toBe(true);
    expect(store.deleteContextPack(pack.id)).toBe(false);
    store.close();
  });
});
