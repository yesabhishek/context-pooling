import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeClaudeProjectPath, listSessionCandidates, parseClaudeSession, parseCodexSession, parseGeminiSession, resolveSessionSource } from "./session.js";
import { claude, codex, gemini, isolateEnv, tempDir, writeJsonl } from "./test-helpers.js";
import type { CtxError } from "./util.js";

let env: ReturnType<typeof isolateEnv>;
beforeEach(() => {
  env = isolateEnv();
});

describe("Claude sessions", () => {
  it("keeps tool results out of the user's messages", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(env.claudeHome, "s.jsonl"), [
      claude.user(cwd, "Add retry logic to the webhook handler."),
      claude.assistant(cwd, [claude.toolUse("t1", "Bash", { command: "npm test" })]),
      claude.user(cwd, [claude.toolResult("t1", "Tests  12 passed (12)")]),
      claude.assistant(cwd, [claude.text("Retries are in place and tests pass.")])
    ]);

    const session = parseClaudeSession(path);
    const users = session.transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);

    expect(users).toEqual(["Add retry logic to the webhook handler."]);
    expect(session.commands).toMatchObject([{ command: "npm test", status: "passed", exitCode: 0 }]);
  });

  it("records failed commands with their exit code and first error line", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(env.claudeHome, "s.jsonl"), [
      claude.user(cwd, "Fix the build."),
      claude.assistant(cwd, [claude.toolUse("t1", "Bash", { command: "npm run build" })]),
      claude.user(cwd, [claude.toolResult("t1", "Exit code 2\nsrc/a.ts(3,1): error TS2304: Cannot find name 'foo'.", true)])
    ]);

    const [run] = parseClaudeSession(path).commands!;
    expect(run).toMatchObject({ status: "failed", exitCode: 2 });
    expect(run.errorLine).toContain("error TS2304");
  });

  it("tracks the agent's plan, edits, title, and slash commands", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(env.claudeHome, "s.jsonl"), [
      { type: "custom-title", customTitle: "Webhook retries", sessionId: "claude-session" },
      claude.user(cwd, "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>billing</command-args>"),
      claude.user(cwd, "<local-command-stdout>noise</local-command-stdout>"),
      claude.user(cwd, "hidden", { isMeta: true }),
      claude.assistant(cwd, [
        claude.toolUse("p1", "TodoWrite", {
          todos: [
            { content: "Add backoff helper", status: "completed", activeForm: "Adding" },
            { content: "Wire retries into handler", status: "in_progress", activeForm: "Wiring" },
            { content: "Add tests", status: "pending", activeForm: "Testing" }
          ]
        }),
        claude.toolUse("e1", "Edit", { file_path: join(cwd, "src/retry.ts"), old_string: "a", new_string: "b" })
      ])
    ]);

    const session = parseClaudeSession(path);
    expect(session.threadName).toBe("Webhook retries");
    expect(session.transcript.filter((entry) => entry.role === "user").map((entry) => entry.text)).toEqual(["/review billing"]);
    expect(session.plan?.map((item) => item.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(session.edits?.[0].path).toBe(join(cwd, "src/retry.ts"));
  });

  it("applies incremental plan updates", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(env.claudeHome, "s.jsonl"), [
      claude.assistant(cwd, [
        claude.toolUse("p1", "mcp__ccd_turn__update_plan", { items: [{ content: "One", status: "in_progress" }, { content: "Two", status: "pending" }] }),
        claude.toolUse("p2", "mcp__ccd_turn__update_plan", { advance: true })
      ])
    ]);
    expect(parseClaudeSession(path).plan).toEqual([
      { text: "One", status: "completed" },
      { text: "Two", status: "in_progress" }
    ]);
  });

  it("encodes project folders the way Claude Code does", () => {
    expect(encodeClaudeProjectPath("/Users/a/my.app/web_ui")).toBe("-Users-a-my-app-web-ui");
  });
});

describe("Codex sessions", () => {
  it("reads typed items from current Codex logs", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(env.codexHome, "sessions/2026/10/19/rollout-2026-10-19T10-00-00-c1.jsonl"), [
      codex.meta("c1", cwd),
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex, a coding agent." }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add dark mode." }] } },
      codex.userMessage("Add dark mode."),
      codex.command("cargo test", 101, "test result: FAILED. 1 failed"),
      codex.fileChange(join(cwd, "src/theme.rs")),
      codex.agentMessage("Dark mode is wired up; one test still fails.")
    ]);

    const session = parseCodexSession(path);
    expect(session.id).toBe("c1");
    expect(session.transcript.filter((entry) => entry.role !== "tool").map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "Add dark mode."],
      ["assistant", "Dark mode is wired up; one test still fails."]
    ]);
    expect(session.commands).toMatchObject([{ command: "cargo test", status: "failed", exitCode: 101 }]);
    expect(session.edits?.map((edit) => edit.path)).toEqual([join(cwd, "src/theme.rs")]);
  });

  it("reads older logs with function calls, outputs, and update_plan", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(env.codexHome, "sessions/old.jsonl"), [
      codex.meta("c2", cwd),
      { type: "event_msg", payload: { type: "user_message", message: "Speed up the importer." } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Speed up the importer." }] } },
      { type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Profile", status: "completed" }, { step: "Batch writes", status: "in_progress" }] }) } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "x1", arguments: JSON.stringify({ command: ["bash", "-lc", "pytest -q"] }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "x1", output: JSON.stringify({ output: "3 passed", metadata: { exit_code: 0 } }) } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "x2", arguments: JSON.stringify({ command: ["apply_patch", "*** Begin Patch\n*** Update File: importer.py\n@@\n*** End Patch"] }) } },
      { type: "event_msg", payload: { type: "agent_message", message: "Profiling done; batching next." } }
    ]);

    const session = parseCodexSession(path);
    expect(session.transcript.filter((entry) => entry.role === "user")).toHaveLength(1);
    expect(session.plan).toEqual([
      { text: "Profile", status: "completed" },
      { text: "Batch writes", status: "in_progress" }
    ]);
    expect(session.commands).toMatchObject([{ command: "pytest -q", status: "passed", exitCode: 0 }]);
    expect(session.edits?.map((edit) => edit.path)).toEqual(["importer.py"]);
  });
});

describe("Gemini sessions", () => {
  it("reads prompts, replies, commands, edits, and to-dos", () => {
    const cwd = tempDir("work");
    const chats = gemini.project(env.geminiHome, cwd);
    const todos = [
      { description: "Add limiter middleware", status: "completed" },
      { description: "Wire it into the router", status: "in_progress" },
      { description: "Load test", status: "blocked" },
      { description: "Old idea", status: "cancelled" }
    ];
    const calls = [
      gemini.tool("w1", "write_todos", { todos }, "Updated todos"),
      gemini.tool("e1", "replace", { file_path: join(cwd, "src/limit.ts"), old_string: "a", new_string: "b" }, "Edited"),
      gemini.tool("e2", "write_file", { file_path: join(cwd, "src/rejected.ts"), content: "x" }, "", "cancelled"),
      gemini.shell("s1", "npm test", 1, "FAIL src/limit.test.ts\n1 failed, 4 passed"),
      gemini.shell("s2", "npm run lint", 0, "")
    ];
    const path = writeJsonl(join(chats, "session-2026-10-19T10-00-g1aaaaaa.jsonl"), [
      gemini.meta("g1aaaaaa-0000", cwd),
      gemini.user("env", "<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\n</session_context>"),
      gemini.user("u1", [{ text: "Add rate limiting to the API, see @src/app.ts" }, { text: "\n--- Content from referenced files ---" }, { text: "export const app = 1;" }]),
      gemini.reply("g1", "I'll add a limiter.", calls.slice(0, 2)),
      // Gemini CLI rewrites a message in place as its tool calls complete.
      gemini.reply("g1", "I'll add a limiter.", calls),
      { $set: { lastUpdated: "2026-10-19T10:02:00.000Z" } },
      gemini.user("tr", [{ functionResponse: { id: "s1", name: "run_shell_command", response: { output: "Output: 1 failed" } } }]),
      { id: "i1", timestamp: "2026-10-19T10:02:00.000Z", type: "info", content: "Request cancelled." },
      gemini.reply("g2", "The limiter is wired in; one test still fails.")
    ]);

    const session = parseGeminiSession(path);
    expect(session.source).toBe("gemini");
    expect(session.id).toBe("g1aaaaaa-0000");
    expect(session.cwd).toBe(cwd);
    expect(session.transcript.filter((entry) => entry.role !== "tool").map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "Add rate limiting to the API, see @src/app.ts"],
      ["assistant", "I'll add a limiter."],
      ["assistant", "The limiter is wired in; one test still fails."]
    ]);
    expect(session.commands).toMatchObject([
      { command: "npm test", status: "failed", exitCode: 1 },
      { command: "npm run lint", status: "passed", exitCode: 0 }
    ]);
    expect(session.commands?.[0].errorLine).toContain("FAIL");
    expect(session.edits?.map((edit) => edit.path)).toEqual([join(cwd, "src/limit.ts")]);
    expect(session.plan).toEqual([
      { text: "Add limiter middleware", status: "completed" },
      { text: "Wire it into the router", status: "in_progress" },
      { text: "Load test", status: "pending" }
    ]);
  });

  it("prefers what the user typed over @file expansions", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(gemini.project(env.geminiHome, cwd), "session-x.jsonl"), [
      gemini.meta("g2", cwd),
      gemini.user("u1", [{ text: "Explain this file\n--- Content from referenced files ---\nbody" }], { displayContent: [{ text: "Explain @README.md" }] })
    ]);
    expect(parseGeminiSession(path).transcript.map((entry) => entry.text)).toEqual(["Explain @README.md"]);
  });

  it("replays rewinds and metadata updates", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(gemini.project(env.geminiHome, cwd), "session-r.jsonl"), [
      gemini.meta("g3", cwd),
      gemini.user("u1", "Add caching."),
      gemini.reply("g1", "Added an LRU cache."),
      gemini.user("u2", "Actually use Redis."),
      gemini.reply("g2", "Switched to Redis."),
      { $rewindTo: "u2" },
      gemini.user("u3", "Keep the LRU cache but add a TTL."),
      { $set: { summary: "LRU cache with TTL" } }
    ]);

    const session = parseGeminiSession(path);
    expect(session.threadName).toBe("LRU cache with TTL");
    expect(session.transcript.map((entry) => entry.text)).toEqual(["Add caching.", "Added an LRU cache.", "Keep the LRU cache but add a TTL."]);
  });

  it("reads single-file JSON chats from older Gemini CLI builds", () => {
    const cwd = tempDir("work");
    const path = join(gemini.project(env.geminiHome, cwd), "session-2026-01-05T09-30-legacy00.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...gemini.meta("legacy00-1111", cwd),
        messages: [gemini.user("u1", "Port the CLI to Bun."), gemini.reply("g1", "Done; tests pass.", [gemini.shell("s1", "bun test", 0, "12 pass")])]
      })
    );

    const session = resolveSessionSource({ cwd, session: path });
    expect(session).toMatchObject({ source: "gemini", id: "legacy00-1111", matchedCwd: true });
    expect(session.commands).toMatchObject([{ command: "bun test", status: "passed", exitCode: 0 }]);
  });
});

describe("session discovery", () => {
  it("skips Codex subagent and reviewer threads", () => {
    const cwd = tempDir("work");
    writeJsonl(join(env.codexHome, "sessions/a.jsonl"), [codex.meta("main", cwd), codex.userMessage("Main task")]);
    writeJsonl(join(env.codexHome, "sessions/b.jsonl"), [codex.meta("sub", cwd, { thread_source: "subagent", source: { subagent: { thread_spawn: {} } } })]);
    writeJsonl(join(env.codexHome, "sessions/c.jsonl"), [codex.meta("review", cwd, { thread_source: "guardian_review", source: { subagent: { other: "guardian" } } })]);

    expect(listSessionCandidates({ cwd }).map((candidate) => candidate.id)).toEqual(["main"]);
    expect(resolveSessionSource({ cwd, from: "codex" }).id).toBe("main");
  });

  it("skips Claude subagent transcripts", () => {
    const cwd = tempDir("work");
    const project = join(env.claudeHome, "projects", encodeClaudeProjectPath(cwd));
    writeJsonl(join(project, "main.jsonl"), [claude.user(cwd, "Main task")]);
    writeJsonl(join(project, "main/subagents/agent-1.jsonl"), [claude.user(cwd, "Explore the repo", { isSidechain: true, sessionId: "agent-1" })]);

    expect(listSessionCandidates({ cwd, from: "claude" })).toHaveLength(1);
  });

  it("matches sessions started anywhere inside the repository", () => {
    const repo = tempDir("repo");
    writeJsonl(join(env.codexHome, "sessions/a.jsonl"), [codex.meta("nested", join(repo, "packages/api"))]);
    expect(resolveSessionSource({ cwd: repo, repoRoot: repo, from: "codex" }).id).toBe("nested");
  });

  it("explains how to recover when no session matches", () => {
    const cwd = tempDir("work");
    writeJsonl(join(env.codexHome, "sessions/a.jsonl"), [codex.meta("elsewhere", tempDir("other"))]);
    expect(() => resolveSessionSource({ cwd })).toThrowError(/No Codex, Claude, or Gemini session found/);
  });

  it("asks which agent to use when both were just active", () => {
    const cwd = tempDir("work");
    writeJsonl(join(env.codexHome, "sessions/a.jsonl"), [codex.meta("codex-1", cwd)]);
    writeJsonl(join(env.claudeHome, "projects", encodeClaudeProjectPath(cwd), "c.jsonl"), [claude.user(cwd, "Hi there")]);
    expect(() => resolveSessionSource({ cwd })).toThrowError(/both active/);
    expect(resolveSessionSource({ cwd, from: "claude" }).source).toBe("claude");
  });

  it("finds Gemini sessions by project folder and skips subagent chats", () => {
    const cwd = tempDir("work");
    const chats = gemini.project(env.geminiHome, cwd);
    writeJsonl(join(chats, "session-2026-10-19T10-00-main0000.jsonl"), [gemini.meta("main0000-aaaa", cwd), gemini.user("u1", "Add rate limiting")]);
    writeJsonl(join(chats, "main0000-aaaa", "sub-1.jsonl"), [gemini.meta("sub-1", cwd, { kind: "subagent" }), gemini.user("u1", "Explore the repo")]);
    writeJsonl(join(gemini.project(env.geminiHome, tempDir("other"), "other"), "session-x.jsonl"), [gemini.meta("elsewhere", "/elsewhere")]);

    const candidates = listSessionCandidates({ cwd, from: "gemini" });
    expect(candidates.filter((candidate) => candidate.matchedCwd).map((candidate) => [candidate.id, candidate.title])).toEqual([["main0000-aaaa", "Add rate limiting"]]);
    expect(candidates.map((candidate) => candidate.id)).not.toContain("sub-1");
    expect(resolveSessionSource({ cwd }).source).toBe("gemini");
    expect(resolveSessionSource({ cwd, session: "sub-1" }).id).toBe("sub-1");
  });

  it("matches hash-named Gemini project folders by project hash", () => {
    const cwd = realpathSync(tempDir("work"));
    const chats = join(env.geminiHome, "tmp", "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0", "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, "session-old.json"), JSON.stringify({ ...gemini.meta("hashed", cwd), messages: [gemini.user("u1", "Fix the flaky test")] }));
    expect(resolveSessionSource({ cwd, from: "gemini" })).toMatchObject({ id: "hashed", cwd, matchedCwd: true });
  });

  it("asks which agent to use when several were just active", () => {
    const cwd = tempDir("work");
    writeJsonl(join(env.codexHome, "sessions/a.jsonl"), [codex.meta("codex-1", cwd)]);
    writeJsonl(join(env.claudeHome, "projects", encodeClaudeProjectPath(cwd), "c.jsonl"), [claude.user(cwd, "Hi there")]);
    writeJsonl(join(gemini.project(env.geminiHome, cwd), "session-g.jsonl"), [gemini.meta("gemini-1", cwd)]);
    const error = (() => {
      try {
        resolveSessionSource({ cwd });
      } catch (caught) {
        return caught as CtxError;
      }
    })();
    expect(error?.message).toMatch(/^(?:Codex|Claude|Gemini), (?:Codex|Claude|Gemini), and (?:Codex|Claude|Gemini) were all active/);
    expect(error?.hint).toMatch(/^Re-run with --from \w+ \(most recent\), --from \w+, or --from \w+\.$/);
    expect(resolveSessionSource({ cwd, from: "gemini" }).id).toBe("gemini-1");
  });

  it("resolves an explicit session by path or id prefix", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(env.codexHome, "sessions/x.jsonl"), [codex.meta("01a15320-abcd", cwd)]);
    expect(resolveSessionSource({ cwd, session: path }).matchedCwd).toBe(true);
    expect(resolveSessionSource({ cwd, session: "01a15320" }).id).toBe("01a15320-abcd");
  });
});
