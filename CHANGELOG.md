# Changelog

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
