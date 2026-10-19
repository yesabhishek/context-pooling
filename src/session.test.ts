import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeClaudeProjectPath, listSessionCandidates, parseClaudeSession, parseCodexSession, resolveSessionSource } from "./session.js";
import { claude, codex, isolateEnv, tempDir, writeJsonl } from "./test-helpers.js";

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
    expect(() => resolveSessionSource({ cwd })).toThrowError(/No Codex or Claude session found/);
  });

  it("asks which agent to use when both were just active", () => {
    const cwd = tempDir("work");
    writeJsonl(join(env.codexHome, "sessions/a.jsonl"), [codex.meta("codex-1", cwd)]);
    writeJsonl(join(env.claudeHome, "projects", encodeClaudeProjectPath(cwd), "c.jsonl"), [claude.user(cwd, "Hi there")]);
    expect(() => resolveSessionSource({ cwd })).toThrowError(/both active/);
    expect(resolveSessionSource({ cwd, from: "claude" }).source).toBe("claude");
  });

  it("resolves an explicit session by path or id prefix", () => {
    const cwd = tempDir("work");
    const path = writeJsonl(join(env.codexHome, "sessions/x.jsonl"), [codex.meta("01a15320-abcd", cwd)]);
    expect(resolveSessionSource({ cwd, session: path }).matchedCwd).toBe(true);
    expect(resolveSessionSource({ cwd, session: "01a15320" }).id).toBe("01a15320-abcd");
  });
});
