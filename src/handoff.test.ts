import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildHandoffSummary,
  buildSections,
  buildTeamTimelineExport,
  createContextPack,
  createHandoff,
  deriveContextBlocks,
  normalizeHandoffPacket,
  renderAgentContextMarkdown,
  renderContextPackOutput
} from "./handoff.js";
import { extractInterestingSnippets } from "./logs.js";
import { captureGitSnapshot, inferTaskName, parseFileChanges } from "./repo.js";
import { parseClaudeSession, parseCodexSession, resolveSessionSource } from "./session.js";
import { openStore } from "./store.js";
import { isLocalRequest, isValidContextPackBody, readRepoFileForView } from "./ui.js";

describe("handoff generation", () => {
  it("extracts useful operational sections from agent snippets", () => {
    const sections = buildSections(
      "billing-entitlements",
      ["src/app/api/stripe/webhook/route.ts"],
      "1 file changed, 20 insertions(+)",
      [
        {
          source: "codex",
          path: "/tmp/session.jsonl",
          modifiedAt: new Date().toISOString(),
          snippets: [
            "Completed webhook route inspection.",
            "TODO make webhook processing idempotent.",
            "Error: DATABASE_URL is missing.",
            "Decision: do not trust client-side subscription state.",
            "npm test failed because DATABASE_URL is missing."
          ]
        }
      ]
    );

    expect(sections.completed[0]).toContain("Completed");
    expect(sections.todos[0]).toContain("TODO");
    expect(sections.blockers[0]).toContain("DATABASE_URL");
    expect(sections.filesTouched).toEqual(["src/app/api/stripe/webhook/route.ts"]);
    expect(sections.nextBestAction).toContain("TODO");
  });

  it("extracts transcript file paths into filesTouched", () => {
    const sections = buildSections(
      "contextpool-ui",
      [],
      "",
      [
        {
          source: "codex",
          path: "/tmp/session.jsonl",
          modifiedAt: new Date().toISOString(),
          snippets: [
            "Updated src/ui.ts and src/handoff.ts to improve copy actions.",
            "Also touched docs/notes.md."
          ]
        }
      ]
    );

    expect(sections.filesTouched).toContain("src/ui.ts");
    expect(sections.filesTouched).toContain("src/handoff.ts");
    expect(sections.filesTouched).toContain("docs/notes.md");
  });

  it("dedupes overlap between dirty files and transcript files", () => {
    const sections = buildSections(
      "contextpool-ui",
      ["src/ui.ts", "src/store.ts"],
      "",
      [
        {
          source: "codex",
          path: "/tmp/session.jsonl",
          modifiedAt: new Date().toISOString(),
          snippets: ["I modified src/ui.ts and added src/handoff.ts."]
        }
      ]
    );

    expect(sections.filesTouched).toEqual(["src/ui.ts", "src/store.ts", "src/handoff.ts"]);
  });

  it("parses git porcelain statuses into structured file changes", () => {
    const changes = parseFileChanges(
      [" M src/ui.ts", "A  src/new.ts", "D  src/old.ts", "R  src/from.ts -> src/to.ts", "?? notes.md"].join("\n"),
      ["10\t2\tsrc/ui.ts", "4\t0\tsrc/new.ts", "0\t8\tsrc/old.ts", "3\t1\tsrc/to.ts"].join("\n"),
      "diff --git a/src/ui.ts b/src/ui.ts\n@@ -1 +1 @@\n-old\n+new"
    );

    expect(changes.map((change) => [change.path, change.status])).toEqual([
      ["src/ui.ts", "modified"],
      ["src/new.ts", "added"],
      ["src/old.ts", "deleted"],
      ["src/to.ts", "renamed"],
      ["notes.md", "untracked"]
    ]);
    expect(changes[0].additions).toBe(10);
    expect(changes[0].deletions).toBe(2);
    expect(changes[0].diff).toContain("diff --git");
    expect(changes[3].oldPath).toBe("src/from.ts");
  });

  it("builds a continuity summary with original question, plan, and leftover work", () => {
    const sections = buildSections(
      "contextpool-ui",
      ["src/ui.ts"],
      "1 file changed, 10 insertions(+)",
      [
        {
          source: "codex",
          path: "/tmp/session.jsonl",
          modifiedAt: new Date().toISOString(),
          snippets: [
            "Completed git parsing.",
            "TODO add file drawer actions.",
            "Decision: keep the store schema compatible."
          ]
        }
      ]
    );
    const summary = buildHandoffSummary(
      "contextpool-ui",
      {
        repoPath: "/repo",
        isGitRepo: true,
        branch: "main",
        commit: "abc123",
        dirtyFiles: ["src/ui.ts"],
        fileChanges: [{ path: "src/ui.ts", status: "modified", additions: 10, deletions: 2, staged: false, unstaged: true, untracked: false }],
        diffStat: "",
        diffPatch: "",
        diffPatchTruncated: false,
        recentCommits: []
      },
      {
        source: "codex",
        id: "session-1",
        path: "/tmp/session.jsonl",
        cwd: "/repo",
        updatedAt: "2026-05-26T12:00:00.000Z",
        matchedCwd: true,
        lineCount: 3,
        transcript: [
          { role: "user", text: "Please make ContextPool a portable handoff dashboard." },
          { role: "assistant", text: "Plan: add structured summaries, file drawer, and MCP export." }
        ],
        transcriptExcerpt: ""
      },
      sections
    );

    expect(summary.originalQuestion).toContain("portable handoff dashboard");
    expect(summary.agentPlan).toContain("structured summaries");
    expect(summary.latestUserInstruction).toContain("portable handoff dashboard");
    expect(summary.latestAssistantSummary).toContain("structured summaries");
    expect(summary.workPhase).toBe("implementation");
    expect(summary.repoStats.dirtyFiles).toBe(1);
    expect(summary.verification.status).toBe("unknown");
    expect(summary.contextSignals.some((signal) => signal.kind === "decision")).toBe(true);
    expect(summary.completedWork[0]).toContain("Completed git parsing");
    expect(summary.remainingWork[0]).toContain("file drawer actions");
    expect(summary.fileChanges[0].path).toBe("src/ui.ts");
  });

  it("normalizes older handoff packets without handoffSummary", () => {
    const packet = normalizeHandoffPacket({
      id: "old",
      task: "legacy",
      createdAt: "2026-05-26T12:00:00.000Z",
      repo: {
        repoPath: "/repo",
        isGitRepo: true,
        branch: "main",
        commit: "abc123",
        dirtyFiles: ["src/legacy.ts"],
        diffStat: "",
        diffPatch: "",
        diffPatchTruncated: false,
        recentCommits: []
      },
      sources: [],
      sections: {
        goal: "Continue legacy.",
        currentStatus: [],
        completed: [],
        inProgress: [],
        todos: ["TODO finish legacy support."],
        blockers: [],
        filesTouched: ["src/legacy.ts"],
        commandsRun: [],
        errors: [],
        decisions: [],
        doNotRepeat: [],
        nextBestAction: "Finish legacy support."
      },
      markdown: "",
      markdownPath: "/tmp/legacy.md"
    });

    expect(packet.handoffSummary?.fileChanges[0].path).toBe("src/legacy.ts");
    expect(packet.handoffSummary?.latestUserInstruction).toBeTruthy();
    expect(packet.handoffSummary?.repoStats.dirtyFiles).toBe(1);
    expect(renderAgentContextMarkdown(packet)).toContain("## Leftover Work");
    expect(renderAgentContextMarkdown(packet)).toContain("## Latest User Instruction");
  });

  it("reads in-repo text files for the dashboard viewer", () => {
    const repo = mkdtempSync(join(tmpdir(), "ctxpool-viewer-"));
    writeFileSync(join(repo, "app.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, ".env.example"), "OPENAI_API_KEY=abc123\nNEXT_PUBLIC_APP_URL=http://localhost:3000\n");

    const result = readRepoFileForView(repo, "app.ts");
    const envResult = readRepoFileForView(repo, ".env.example");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.language).toBe("typescript");
      expect(result.content).toContain("value");
    }
    expect(envResult.ok).toBe(true);
    if (envResult.ok) {
      expect(envResult.redacted).toBe(true);
      expect(envResult.content).toContain("OPENAI_API_KEY=[redacted]");
      expect(envResult.content).not.toContain("abc123");
    }
  });

  it("rejects unsafe or unsupported file viewer paths", () => {
    const repo = mkdtempSync(join(tmpdir(), "ctxpool-viewer-safe-"));
    const outside = mkdtempSync(join(tmpdir(), "ctxpool-viewer-outside-"));
    writeFileSync(join(repo, "image.png"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(outside, "secret.txt"), "secret\n");

    expect(readRepoFileForView(repo, "../secret.txt").ok).toBe(false);
    expect(readRepoFileForView(repo, join(outside, "secret.txt")).ok).toBe(false);
    expect(readRepoFileForView(repo, "image.png").ok).toBe(false);
    expect(readRepoFileForView(repo, ".").ok).toBe(false);
  });

  it("accepts only local browser origins for mutating UI requests", () => {
    expect(isLocalRequest({ headers: { host: "127.0.0.1:4377", origin: "http://127.0.0.1:4377" } })).toBe(true);
    expect(isLocalRequest({ headers: { host: "localhost:4377", origin: "http://localhost:4377" } })).toBe(true);
    expect(isLocalRequest({ headers: { host: "127.0.0.1:4377", origin: "https://example.com" } })).toBe(false);
    expect(isLocalRequest({ headers: { host: "0.0.0.0:4377", origin: "http://0.0.0.0:4377" } })).toBe(false);
  });

  it("parses interesting lines out of plain text logs", () => {
    const snippets = extractInterestingSnippets(`
      random chatter
      TODO update dashboard from server state
      npm test failed with entitlement assertion
    `);

    expect(snippets).toContain("TODO update dashboard from server state");
    expect(snippets).toContain("npm test failed with entitlement assertion");
  });

  it("infers task from branch when available", () => {
    const repo = captureGitSnapshot(process.cwd());
    const task = inferTaskName("Billing Entitlements", repo);
    expect(task).toBe("billing-entitlements");
  });

  it("captures git diff stat and patch for dirty files", () => {
    const repo = mkdtempSync(join(tmpdir(), "ctxpool-git-repo-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ctxpool@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "ContextPool Test"], { cwd: repo });
    writeFileSync(join(repo, "app.txt"), "hello\n");
    execFileSync("git", ["add", "app.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "app.txt"), "hello\nworld\n");

    const snapshot = captureGitSnapshot(repo);

    expect(snapshot.dirtyFiles).toContain("app.txt");
    expect(snapshot.fileChanges?.[0].path).toBe("app.txt");
    expect(snapshot.fileChanges?.[0].status).toBe("modified");
    expect(snapshot.diffStat).toContain("app.txt");
    expect(snapshot.diffPatch).toContain("diff --git");
    expect(snapshot.diffPatch).toContain("+world");
    expect(snapshot.diffPatchTruncated).toBe(false);
  });

  it("creates and stores a handoff packet", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxpool-test-"));
    process.env.CTXPOOL_HOME = home;
    const repo = mkdtempSync(join(tmpdir(), "ctxpool-repo-"));
    writeFileSync(join(repo, "notes.txt"), "TODO finish MCP handoff test");
    const sessionPath = join(repo, "codex-session.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-123", cwd: repo, timestamp: "2026-05-26T12:00:00.000Z" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Please implement MCP handoff capture." } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed parser setup. TODO finish MCP handoff test." }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"npm test\"}" } })
      ].join("\n")
    );

    const packet = await createHandoff({ cwd: repo, task: "MCP Handoff", session: sessionPath, useOllama: false });
    const store = await openStore();
    store.saveHandoff(packet);
    const latest = store.getLatestHandoff("mcp-handoff");
    store.close();

    expect(packet.markdown).toContain("# Handoff: mcp-handoff");
    expect(packet.repo.diffPatch).toBeDefined();
    expect(packet.repo.diffPatchTruncated).toBe(false);
    expect(packet.markdown).toContain("## Source Session");
    expect(packet.markdown).toContain("## Exported Transcript Excerpt");
    expect(packet.markdown).toContain("Please implement MCP handoff capture.");
    expect(latest?.task).toBe("mcp-handoff");
    expect(latest?.markdown).toContain("Next Best Action");
    expect(packet.engineeringMemory?.positioning.moat).toBe("provenance-backed-engineering-memory");
    expect(packet.engineeringMemory?.identity.sessionId).toBe("codex-123");
    expect(packet.engineeringMemory?.nextActions[0]?.provenance.kind).toBe("ai-inferred");
  });

  it("exports sync-ready team timeline packets without raw transcripts by default", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxpool-team-export-test-"));
    process.env.CTXPOOL_HOME = home;
    const repo = mkdtempSync(join(tmpdir(), "ctxpool-team-repo-"));
    const sessionPath = join(repo, "codex-session.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-team", cwd: repo, timestamp: "2026-05-26T12:00:00.000Z" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Continue this task in another agent." } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Decision: preserve local-first sync controls." }] } })
      ].join("\n")
    );

    const packet = await createHandoff({ cwd: repo, task: "Team Timeline", session: sessionPath, useOllama: false });
    const exported = buildTeamTimelineExport(packet);

    expect(exported.engineeringMemory?.teamSync.mode).toBe("sync-ready");
    expect(exported.engineeringMemory?.teamSync.rawTranscript).toBe("excluded");
    expect(exported.sourceSession?.transcript).toEqual([]);
    expect(exported.sources[0]?.snippets).toEqual([]);
    expect(exported.markdown).not.toContain("## Exported Transcript Excerpt");
    expect(exported.engineeringMemory?.decisions[0]?.provenance.kind).toBe("transcript-derived");
  });

  it("derives reusable context blocks and renders a redacted prompt pack", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxpool-pack-test-"));
    process.env.CTXPOOL_HOME = home;
    const repo = mkdtempSync(join(tmpdir(), "ctxpool-pack-repo-"));
    const sessionPath = join(repo, "codex-session.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-pack", cwd: repo, timestamp: "2026-05-26T12:00:00.000Z" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Please continue checkout work. OPENAI_API_KEY=abc123" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Decision: preserve local-first context packs. TODO wire prompt export." }] } })
      ].join("\n")
    );

    const packet = await createHandoff({ cwd: repo, task: "Context Pack", session: sessionPath, useOllama: false });
    const blocks = deriveContextBlocks(packet);
    const pack = createContextPack("Checkout continuation", blocks.slice(0, 4));
    const output = renderContextPackOutput(pack);

    expect(blocks.some((block) => block.category === "decision")).toBe(true);
    expect(blocks.some((block) => block.category === "transcript")).toBe(true);
    expect(output.markdown).toContain("# Context Pack: Checkout continuation");
    expect(output.markdown).toContain("local-first context packs");
    expect(output.markdown).not.toContain("abc123");
    expect(output.warnings.length).toBeGreaterThan(0);
  });

  it("stores saved context packs", async () => {
    process.env.CTXPOOL_HOME = mkdtempSync(join(tmpdir(), "ctxpool-pack-store-test-"));
    const store = await openStore();
    const pack = createContextPack("Saved Pack", [
      {
        id: "block-1",
        sourceHandoffId: "handoff-1",
        sourceTask: "task",
        sourceCreatedAt: "2026-05-26T12:00:00.000Z",
        category: "decision",
        title: "Decision",
        text: "Use saved packs.",
        provenance: { kind: "user-authored", confidence: "high", source: "test" },
        estimatedChars: 16
      }
    ]);

    store.saveContextPack(pack);
    const listed = store.listContextPacks();
    const found = store.getContextPackById(pack.id);
    store.close();

    expect(listed[0]?.name).toBe("Saved Pack");
    expect(found?.items[0]?.block.text).toBe("Use saved packs.");
  });

  it("rejects invalid context pack payloads", () => {
    expect(isValidContextPackBody({ id: "pack", name: "Bad", items: [{ id: "item" }] })).toBe(false);
    expect(
      isValidContextPackBody({
        id: "pack",
        name: "Good",
        items: [
          {
            id: "item",
            blockId: "block",
            order: 0,
            enabled: true,
            block: {
              id: "block",
              sourceHandoffId: "handoff",
              sourceTask: "task",
              sourceCreatedAt: "2026-05-26T12:00:00.000Z",
              category: "decision",
              title: "Decision",
              text: "Use context packs.",
              provenance: { kind: "user-authored", confidence: "high", source: "test" },
              estimatedChars: 18
            }
          }
        ]
      })
    ).toBe(true);
  });

  it("keeps README MCP tool list aligned with registered server tools", () => {
    const readme = readFileSync("README.md", "utf8");
    const mcpSource = readFileSync("src/mcp.ts", "utf8");
    const documented = Array.from(readme.matchAll(/- `(get_[^`]+|list_[^`]+)`/g)).map((match) => match[1]);
    const registered = Array.from(mcpSource.matchAll(/server\.registerTool\(\s*\n\s*"([^"]+)"/g)).map((match) => match[1]);

    expect(documented.sort()).toEqual(registered.sort());
  });

  it("parses Codex session metadata and transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxpool-codex-parser-"));
    const path = join(dir, "rollout-2026-05-26T12-00-00-codex-123.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-123", cwd: dir, timestamp: "2026-05-26T12:00:00.000Z", base_instructions: { text: "do not include" } } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Build a handoff exporter." } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "npm test failed with one parser error" } })
      ].join("\n")
    );

    const session = parseCodexSession(path);
    expect(session.id).toBe("codex-123");
    expect(session.cwd).toBe(dir);
    expect(session.transcriptExcerpt).toContain("Build a handoff exporter.");
    expect(session.transcriptExcerpt).toContain("npm test failed");
    expect(session.transcriptExcerpt).not.toContain("base_instructions");
  });

  it("parses Claude session messages without metadata-only records", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxpool-claude-parser-"));
    const path = join(dir, "claude-session.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>ignore</local-command-caveat>" }, cwd: dir, sessionId: "claude-123", timestamp: "2026-05-26T12:00:00.000Z" }),
        JSON.stringify({ type: "user", message: { role: "user", content: "Continue the billing task." }, cwd: dir, sessionId: "claude-123", timestamp: "2026-05-26T12:01:00.000Z" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Added tests and found a blocker." }] }, cwd: dir, sessionId: "claude-123", timestamp: "2026-05-26T12:02:00.000Z" })
      ].join("\n")
    );

    const session = parseClaudeSession(path);
    expect(session.id).toBe("claude-123");
    expect(session.transcriptExcerpt).toContain("Continue the billing task.");
    expect(session.transcriptExcerpt).toContain("Added tests");
    expect(session.transcriptExcerpt).not.toContain("local-command-caveat");
  });

  it("resolves an explicit session path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxpool-resolve-"));
    const path = join(dir, "codex-session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "codex-explicit", cwd: dir, timestamp: "2026-05-26T12:00:00.000Z" } }));

    const session = resolveSessionSource({ from: "codex", cwd: dir, session: path });
    expect(session.id).toBe("codex-explicit");
    expect(session.matchedCwd).toBe(true);
  });
});
