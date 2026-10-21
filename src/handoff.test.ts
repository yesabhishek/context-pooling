import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildHandoffSummary, buildSections, buildTeamTimelineExport, createHandoff, deriveContextBlocks, normalizeHandoffPacket, renderAgentContextMarkdown, summarizeHandoff } from "./handoff.js";
import { createContextPack, renderContextPackOutput } from "./pack.js";
import { openStore } from "./store.js";
import { claude, codex, commitAll, gitRepo, isolateEnv, tempDir, writeJsonl } from "./test-helpers.js";
import type { GitSnapshot, HandoffPacket } from "./types.js";

let env: ReturnType<typeof isolateEnv>;
beforeEach(() => {
  env = isolateEnv();
});

const emptyRepo: GitSnapshot = {
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
};

describe("handoff from a real session", () => {
  it("leads with the failing check and its error", async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
    commitAll(repo);
    writeFileSync(join(repo, "app.ts"), "export const a = 2;\n");
    const path = writeJsonl(join(env.claudeHome, "s.jsonl"), [
      claude.user(repo, "Make the importer idempotent."),
      claude.assistant(repo, [claude.toolUse("e1", "Edit", { file_path: join(repo, "app.ts") }), claude.toolUse("t1", "Bash", { command: "npm test 2>&1 | tail -20" })]),
      claude.user(repo, [claude.toolResult("t1", "FAIL src/import.test.ts\nAssertionError: expected 2 to equal 1\nTests  1 failed | 4 passed")]),
      claude.assistant(repo, [claude.text("One assertion still fails; the duplicate check runs too late.")])
    ]);

    const packet = await createHandoff({ cwd: repo, session: path });

    expect(packet.handoffSummary?.verification.status).toBe("failed");
    expect(packet.handoffSummary?.workPhase).toBe("debugging");
    expect(packet.sections.nextBestAction).toMatch(/^Fix the failing `npm test`/);
    expect(packet.markdown).toContain("## Next action");
    expect(packet.markdown).toContain("- M app.ts (+1 -1)");
    expect(packet.markdown).toContain("✗ `npm test`");
    expect(packet.sourceSession?.edits?.[0].path).toBe("app.ts");
  });

  it("follows the agent's plan when there is one", async () => {
    const repo = gitRepo();
    const path = writeJsonl(join(env.claudeHome, "s.jsonl"), [
      claude.user(repo, "Ship the billing page."),
      claude.assistant(repo, [
        claude.toolUse("p", "TodoWrite", {
          todos: [
            { content: "Build the pricing table", status: "completed" },
            { content: "Hook up checkout", status: "in_progress" },
            { content: "Add receipts", status: "pending" }
          ]
        })
      ])
    ]);

    const packet = await createHandoff({ cwd: repo, session: path });
    expect(packet.sections.nextBestAction).toBe("Continue: Hook up checkout");
    expect(packet.markdown).toContain("- [x] Build the pricing table");
    expect(packet.markdown).toContain("- [ ] Hook up checkout (in progress)");
    expect(packet.handoffSummary?.workPhase).toBe("implementation");
  });

  it("flags checks that passed before the last edit", async () => {
    const repo = gitRepo();
    const path = writeJsonl(join(env.codexHome, "sessions/r.jsonl"), [
      codex.meta("c1", repo),
      codex.userMessage("Tidy the parser."),
      codex.command("cargo test", 0, "test result: ok"),
      codex.fileChange(join(repo, "src/parser.rs")),
      codex.agentMessage("Refactored the parser.")
    ]);

    const summary = (await createHandoff({ cwd: repo, session: path })).handoffSummary!;
    expect(summary.verification.status).toBe("unknown");
    expect(summary.verification.gaps).toContain("Files were edited after the last passing check.");
  });

  it("is ready for review when the plan is done and checks pass", async () => {
    const repo = gitRepo();
    const path = writeJsonl(join(env.codexHome, "sessions/r.jsonl"), [
      codex.meta("c1", repo),
      codex.userMessage("Add a health endpoint."),
      codex.fileChange(join(repo, "src/health.ts")),
      codex.command("npm test", 0, "Tests 8 passed"),
      codex.agentMessage("Added /health with tests.")
    ]);
    expect((await createHandoff({ cwd: repo, session: path })).handoffSummary?.workPhase).toBe("review");
  });

  it("redacts secrets from transcripts and diffs, and omits .env diffs", async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, ".env"), "A=1\n");
    writeFileSync(join(repo, "config.ts"), "export const x = 1;\n");
    commitAll(repo);
    writeFileSync(join(repo, ".env"), "STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234\n");
    writeFileSync(join(repo, "config.ts"), 'export const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789";\n');
    const path = writeJsonl(join(env.claudeHome, "s.jsonl"), [claude.user(repo, "Use OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789 for the client.")]);

    const packet = await createHandoff({ cwd: repo, session: path });
    const stored = JSON.stringify(packet);

    expect(stored).not.toContain("sk-proj-AbCdEf");
    expect(stored).not.toContain("sk_live_abcdef");
    expect(packet.repo.diffPatch).toContain("diff omitted for sensitive file");
    expect(packet.markdown).toContain("OPENAI_API_KEY=[redacted");
  });

  it("writes the markdown file privately and stores the packet", async () => {
    const repo = gitRepo();
    const path = writeJsonl(join(env.codexHome, "sessions/r.jsonl"), [codex.meta("c1", repo), codex.userMessage("Continue the migration.")]);

    const packet = await createHandoff({ cwd: repo, task: "DB Migration", session: path });
    const store = await openStore();
    store.saveHandoff(packet);
    const latest = store.getLatestHandoff("db-migration");
    store.close();

    expect(readFileSync(packet.markdownPath, "utf8")).toBe(packet.markdown);
    expect(packet.markdown.startsWith("# Handoff: db-migration")).toBe(true);
    expect(packet.tokenEstimate).toBeGreaterThan(0);
    expect(latest?.engineeringMemory?.identity.sessionId).toBe("c1");
    expect(packet.markdown).not.toMatch(/Buyer|Moat/);
  });
});

describe("prose heuristics", () => {
  it("extracts completed work, todos, blockers, and decisions from plain snippets", () => {
    const sections = buildSections("billing", ["src/webhook.ts"], "", [
      {
        source: "codex",
        path: "/tmp/s.jsonl",
        modifiedAt: "2026-10-19T00:00:00.000Z",
        snippets: [
          "Completed webhook route inspection.",
          "TODO make webhook processing idempotent.",
          "Blocked: DATABASE_URL is missing.",
          "Decision: do not trust client-side subscription state.",
          "Updated src/ui.ts and docs/notes.md."
        ]
      }
    ]);

    expect(sections.completed).toContain("Completed webhook route inspection.");
    expect(sections.todos[0]).toContain("idempotent");
    expect(sections.blockers[0]).toContain("DATABASE_URL");
    expect(sections.decisions[0]).toContain("client-side subscription");
    expect(sections.filesTouched).toEqual(["src/webhook.ts", "src/ui.ts", "docs/notes.md"]);
    expect(sections.nextBestAction).toMatch(/^Resolve the blocker/);
  });

  it("builds a continuity summary from a minimal session", () => {
    const sections = buildSections("ui", ["src/ui.ts"], "", []);
    const summary = buildHandoffSummary("ui", emptyRepo, {
      source: "codex",
      id: "s1",
      path: "/tmp/s.jsonl",
      updatedAt: "2026-10-19T00:00:00.000Z",
      matchedCwd: true,
      lineCount: 2,
      transcript: [
        { role: "user", text: "Make the dashboard portable." },
        { role: "assistant", text: "Plan: add structured summaries and an MCP export." }
      ],
      transcriptExcerpt: ""
    }, sections);

    expect(summary.originalQuestion).toBe("Make the dashboard portable.");
    expect(summary.agentPlan).toContain("structured summaries");
    expect(summary.workPhase).toBe("implementation");
    expect(summary.repoStats).toMatchObject({ dirtyFiles: 1, additions: 10, deletions: 2 });
  });
});

describe("older packets", () => {
  const legacy: HandoffPacket = {
    id: "old",
    task: "legacy",
    createdAt: "2026-05-26T12:00:00.000Z",
    repo: { ...emptyRepo, fileChanges: undefined, dirtyFiles: ["src/legacy.ts"], diffPatch: "+const token = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab'" },
    sources: [],
    sections: {
      goal: "",
      currentStatus: [],
      completed: [],
      inProgress: [],
      todos: ["Finish legacy support."],
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
  };

  it("normalizes packets saved without a summary", () => {
    const packet = normalizeHandoffPacket(legacy);
    expect(packet.handoffSummary?.fileChanges[0].path).toBe("src/legacy.ts");
    expect(renderAgentContextMarkdown(packet)).toContain("## Next action\nFinish legacy support.");
  });

  it("drops injected harness text that pre-0.2 captures kept as user messages", () => {
    const packet = normalizeHandoffPacket({
      ...legacy,
      sourceSession: {
        source: "codex",
        id: "old-session",
        path: "/tmp/old.jsonl",
        updatedAt: legacy.createdAt,
        matchedCwd: true,
        lineCount: 4,
        transcriptExcerpt: "",
        transcript: [
          { role: "user", text: "<environment_context>\n<cwd>/repo</cwd>\n<shell>zsh</shell>\n</environment_context>" },
          { role: "user", text: "# AGENTS.md instructions for /repo\nDo not additionally call list_mcp_resources." },
          { role: "user", text: "Rebuild the settings page with better UX." },
          { role: "assistant", text: "Decided to keep the existing routes and only restyle the page." }
        ]
      }
    });
    expect(packet.handoffSummary?.originalQuestion).toBe("Rebuild the settings page with better UX.");
    expect(packet.handoffSummary?.decisions).toEqual(["Decided to keep the existing routes and only restyle the page."]);
    expect(deriveContextBlocks(packet).map((block) => block.text).join("\n")).not.toMatch(/environment_context|AGENTS\.md|list_mcp_resources/);
  });

  it("summarizes a handoff for lists without its transcript or diff", () => {
    const item = summarizeHandoff(legacy);
    expect(item).toMatchObject({ id: "old", task: "legacy", repoName: "repo", branch: "main", verification: "unknown", files: { count: 1, paths: ["src/legacy.ts"] } });
    expect(summarizeHandoff({ ...legacy, markdown: "x".repeat(40) }).tokens).toBe(10);
    expect(JSON.stringify(item)).not.toContain("ghp_");
  });

  it("redacts secrets in team exports even when the stored packet was not redacted", () => {
    const exported = buildTeamTimelineExport(legacy);
    expect(exported.repo.diffPatch).not.toContain("ghp_");
    expect(exported.engineeringMemory?.teamSync).toMatchObject({ mode: "sync-ready", rawTranscript: "excluded" });
  });
});

describe("context packs", () => {
  it("leaves transcript blocks out unless the pack opts in", async () => {
    const repo = gitRepo();
    const path = writeJsonl(join(env.codexHome, "sessions/r.jsonl"), [
      codex.meta("c1", repo),
      codex.userMessage("Please continue the checkout work from yesterday."),
      codex.agentMessage("Decision: keep packs local-first. Wiring the export next.")
    ]);
    const blocks = deriveContextBlocks(await createHandoff({ cwd: repo, session: path }));
    expect(blocks.some((block) => block.category === "decision")).toBe(true);

    const transcript = blocks.filter((block) => block.category === "transcript");
    const intent = blocks.filter((block) => block.category === "intent");
    const pack = createContextPack("Checkout", [...intent, ...transcript]);
    const output = renderContextPackOutput(pack);

    expect(output.markdown).toContain("# Context: Checkout");
    expect(output.json.items.every((item) => item.block.category !== "transcript")).toBe(true);
    expect(output.warnings[0]).toMatch(/transcript blocks? (is|are) left out/);
    expect(renderContextPackOutput({ ...pack, includeRawTranscript: true }).json.items.length).toBe(intent.length + transcript.length);
  });
});

describe("docs", () => {
  it("lists exactly the registered MCP tools in the README", () => {
    const readme = readFileSync("README.md", "utf8");
    const source = readFileSync("src/mcp.ts", "utf8");
    const documented = Array.from(readme.matchAll(/^\| `((?:get|list)_[a-z_]+)`/gm), (match) => match[1]);
    const registered = Array.from(source.matchAll(/registerTool\(\s*"([^"]+)"/g), (match) => match[1]);
    expect(documented.sort()).toEqual(registered.sort());
  });
});

it("never reads real agent folders in tests", () => {
  expect(process.env.CODEX_HOME).toContain("ctxpool-codex-");
  expect(tempDir("x")).toContain("ctxpool-x-");
});
