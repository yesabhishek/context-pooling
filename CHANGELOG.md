# Changelog

## 0.5.0

The web UI is rebuilt around handoffs instead of the pack editor.

### Added

- **Overview dashboard**: the latest handoff and its next action, handoffs over time stacked by agent, a relay view of how each task moved between agents, check outcomes at handoff, and the most-handed-off files. Filter by 7, 30, or 90 days, or all time.
- **Handoffs list** with each source agent's logo, repo, branch and commit, checks, diff size, and phase, grouped by day. Filter by agent, task, or check status, or search.
- **Handoff detail** with tabs for the overview (next action, objective, plan progress, checks with exit codes, decisions, constraints, blockers), changed files with diffs, the transcript, and the exact markdown that was copied. A session activity strip shows edits and command runs in order, so checks that passed before the last edit stand out.
- **Continue in**: copies a command that starts Claude Code, Codex, or Gemini CLI with the handoff as the first prompt, or a prompt for any agent connected over MCP.
- **Connect agents** page with MCP setup for Claude Code, Codex, Gemini CLI, and Cursor, and which agents' session folders exist on this machine.
- <kbd>⌘K</kbd> search across handoffs, tasks, and packs. New handoffs appear without a reload.
- `ctxpool show --id <id>` prints a specific handoff.
- `/api/status` and `/api/handoffs?view=list` for the UI, and `/api/context-blocks?handoff=<id>`.

### Changed

- **Context packs** group blocks the way they export, save as you edit, show where their tokens go, and take blocks from a handoff through **Add to pack**.
- Handoffs saved before 0.2 no longer show injected harness text (environment context, AGENTS.md, system reminders) as the objective, decisions, or constraints.
- Light, dark, and system themes, and a layout that works on phones.
- Copy buttons fall back to a legacy copy when the Clipboard API is unavailable, such as when the UI is opened from another device with `--host 0.0.0.0`.

## 0.4.0

Antigravity CLI joins Codex, Claude, and Gemini as a handoff source. Upgrading from 0.1.x? Read 0.3.0 and 0.2.0 too; 0.2.0 has breaking changes.

### Added

- **Antigravity CLI sessions** are a handoff source. ContextPool reads `agy`'s conversation databases in `~/.gemini/antigravity-cli/conversations` without writing to them, decoding each step with the field numbers from the protos `agy` ships. It reads your prompts, the agent's replies, shell commands with exit codes (including background commands that report later), file edits, and the latest checkpoint summary, which covers turns `agy` has compacted. Titles and workspaces come from `agy`'s conversation index, and subagent conversations are skipped. Older conversations saved as opaque `.pb` files are skipped. Set `CTXPOOL_ANTIGRAVITY_DIR` to read another folder.
- `--from antigravity`, and an Antigravity line in `ctxpool status`.

## 0.3.0

Gemini CLI joins Codex and Claude as a handoff source. Upgrading from 0.1.x? This release also includes everything under 0.2.0, including its breaking changes.

### Added

- **Gemini CLI sessions** are a handoff source. ContextPool reads the chat files in `~/.gemini/tmp/<project>/chats`, both the current `.jsonl` format and older `.json` files. It reads your prompts (without `@file` contents), Gemini's replies, shell commands with exit codes, file edits, the `write_todos` plan, and the plan file from `exit_plan_mode`. Rewound turns and subagent chats are skipped. It honors `GEMINI_CLI_HOME`.
- `--from gemini`, and a Gemini line in `ctxpool status` and the MCP setup help.

### Changed

- **Session selection** asks which agent to use whenever more than one agent was active in the workspace in the last 10 minutes, not just Codex and Claude.

## 0.2.0

Handoffs now come from what the agent actually did, not from guessing at transcript text.

### Changed

- **Session parsing** reads current Codex logs (typed `item_completed` events) and Claude Code logs as they are written today. Tool output is no longer mistaken for user messages.
- **Plans** come from the agent's own to-do tools (`TodoWrite`, `update_plan`, task tools). **Check results** come from real exit codes, and piped checks such as `npm test | tail` are judged by their output.
- **Verification** flags checks that passed before the last edit.
- **Next action** follows a fixed priority: failing check, blocker, in-progress step, next step, unverified changes, then open to-dos.
- **Session selection** skips Codex subagent and reviewer threads and Claude subagent transcripts, and matches sessions started anywhere in the repo. It honors `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
- **Handoff markdown** is shorter and ordered for the next agent. Empty sections are omitted.
- **Secrets** are redacted at capture, including OpenAI, Anthropic, GitHub, AWS, Stripe, Slack, and JWT formats. `.env` and key files are left out of diffs. Commit SHAs and UUIDs are no longer redacted by mistake.
- **Store** uses the built-in `node:sqlite` in WAL mode, so the CLI, UI, and MCP server can write at the same time without losing data. Existing databases open as-is.
- **UI server** rejects requests addressed to other hostnames, cross-origin writes, and non-JSON writes. It sends security headers and does not follow symlinks out of a repository.
- **MCP tools** are marked read-only. `get_latest_agent_context` no longer returns the full packet with transcript and diffs.
- **CLI** output is redesigned, and every listing command supports `--json`.
- **Web UI** is redesigned and shares its pack rendering with the server.

### Breaking

- Requires Node.js 22.13 or later.
- `ctxpool import codex|claude` is replaced by `ctxpool sessions`.
- Ollama is opt-in: pass `--ollama` or set `ollama.enabled` in `config.json`. `--no-ollama` is still accepted.
- Context packs leave transcript blocks out of exports unless **Include transcript** is on.
- `--budget` is a token budget for the transcript excerpt.

## 0.1.1

- Initial open-source release.
