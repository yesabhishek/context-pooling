# ContextPool

Hand off AI coding sessions between agents without losing the thread.

ContextPool reads the Codex, Claude Code, Gemini CLI, or Antigravity CLI session you just worked in, pairs it with the repo's git state, and writes a short handoff the next agent can act on: what was asked, the plan, which checks passed or failed, what changed, and the next action. Everything stays on your machine.

```sh
npm install -g ctxpool
ctxpool handoff
```

```
  Handoff ready

  Task     webhook-retries
  Source   Claude · Webhook retries · 4m ago
  Repo     billing-api · feature/webhook-retries @ 3f2c1a9 · 4 files +182 -37
  Phase    debugging
  Checks   ✗ npm test
           ✓ npm run typecheck
  Next     Fix the failing `npm test` (AssertionError: expected 2 to equal 1), then re-run it.

  ✓ Copied to clipboard · ~1.4k tokens
```

Paste it into the next agent, or let the agent fetch it over MCP.

## How it works

- **Reads the agent's own records.** Plans come from the agent's to-do tools (`TodoWrite`, `update_plan`, `write_todos`). Check results come from real exit codes. Edits come from the agent's edit tools. Prose heuristics only fill gaps, and they read your messages and the agent's, never tool output.
- **Knows when checks are stale.** A pass followed by more edits is flagged as unverified. `npm test | tail` hides failures behind a 0 exit code, so piped checks are judged by their output.
- **Picks the right session.** It uses the most recent primary session started in this repo and skips subagent and reviewer threads. If more than one agent was active in the last 10 minutes, it asks which one to use.
- **Replays Gemini chats the way Gemini CLI does.** Rewound turns are dropped, and `@file` contents are left out of your prompts.
- **Redacts secrets at capture.** API keys, tokens, private keys, and credentials in URLs are redacted before anything is saved or copied. `.env` and key files never appear in diffs.

## Supported agents

| Agent | Sessions read from |
| --- | --- |
| Codex | `~/.codex/sessions` |
| Claude Code | `~/.claude/projects` |
| Gemini CLI | `~/.gemini/tmp/<project>/chats` |
| Antigravity CLI (`agy`) | `~/.gemini/antigravity-cli/conversations` |

Antigravity keeps each conversation in a SQLite database. ContextPool opens it without writing anything, and reads steps that `agy` has compacted out of context through the latest checkpoint summary. Older conversations saved as `.pb` files use an opaque format and are skipped. Cursor isn't supported yet.

## Commands

| Command | What it does |
| --- | --- |
| `ctxpool handoff` | Capture the current session and copy the handoff to the clipboard |
| `ctxpool capture` | Same, without the clipboard |
| `ctxpool sessions` | List the sessions ContextPool can read here (`--all` for every folder) |
| `ctxpool tasks` | List tasks with saved handoffs |
| `ctxpool show [task]` | Print the latest handoff (for a task), or one by `--id` |
| `ctxpool ui` | Browse handoffs, activity charts, and context packs in your browser |
| `ctxpool team export` | Write a redacted, sync-ready JSON packet |
| `ctxpool mcp start` | Serve handoffs to agents over MCP (stdio) |
| `ctxpool status` | Show where data lives and which agents were found |

Useful options for `handoff` and `capture`:

```sh
ctxpool handoff --from gemini          # choose the agent when several were active
ctxpool handoff --session 01a15320     # a specific session id, or a path to a session file
ctxpool handoff --task billing-flow    # name the task (defaults to the branch or repo)
ctxpool handoff --budget 1500          # token budget for the transcript excerpt
ctxpool handoff --no-transcript        # leave the transcript out entirely
ctxpool handoff --json                 # machine-readable output
```

## Connect an agent over MCP

```sh
claude mcp add contextpool -- npx -y ctxpool mcp start
codex mcp add contextpool -- npx -y ctxpool mcp start
gemini mcp add -s user contextpool npx -y ctxpool mcp start
```

All tools are read-only.

| Tool | Returns |
| --- | --- |
| `get_latest_agent_context` | The latest handoff as markdown plus a structured summary. Start here. |
| `get_latest_handoff` | The latest handoff as markdown, optionally for a task |
| `get_handoff_by_task` | The latest handoff for a task |
| `get_task_status` | Next action, blockers, and touched files for a task |
| `get_handoff_files` | Structured file changes from a handoff |
| `list_tasks` | Tasks with handoffs, newest first |
| `get_team_timeline_packet` | A redacted, sync-ready packet. The raw transcript is excluded by default. |
| `list_context_packs` | Saved context packs |
| `get_context_pack` | A context pack as markdown or JSON |

## The web UI

```sh
ctxpool ui --open
```

A local dashboard for everything you've handed off, served from `127.0.0.1:4377`:

- **Overview**: the latest handoff with its next action, handoffs over time by agent, how tasks moved between agents, which checks were passing at handoff, and the files that keep coming back.
- **Handoffs**: every capture, newest first, with the source agent's logo, repo and branch, checks, and diff size. Filter by agent, task, or check status.
- **Handoff detail**: the next action, objective, plan progress, each check with its exit code, changed files with diffs, the transcript, and the exact markdown that was copied. **Continue in** copies a command that starts Claude Code, Codex, or Gemini CLI with the handoff as its first prompt.
- **Connect agents**: the MCP setup command for each agent, and which agents' session folders were found on this machine.

New handoffs appear without a reload. Press <kbd>⌘K</kbd> to jump to any handoff, task, or pack.

## Context packs

A pack combines the parts of several handoffs that still matter (objectives, decisions, constraints, checks, changed files) into one reusable prompt. Open a handoff and choose **Add to pack**, or start a pack and add blocks from any handoff. Packs save as you edit, and agents can read them over MCP with `get_context_pack`. Transcript blocks are left out of exports unless you turn on **Include transcript** for that pack.

## Configuration

`ctxpool init` writes `~/.ctxpool/config.json`:

```json
{
  "version": 1,
  "ui": { "host": "127.0.0.1", "port": 4377 },
  "ollama": { "enabled": false }
}
```

Set `ollama.enabled` (or pass `--ollama`) to have a local Ollama model phrase the next action. It uses `ollama.model` if set, otherwise the first installed model.

| Variable | Purpose |
| --- | --- |
| `CTXPOOL_HOME` | Store location (default `~/.ctxpool`) |
| `CODEX_HOME` | Codex data (default `~/.codex`) |
| `CLAUDE_CONFIG_DIR` | Claude Code data (default `~/.claude`) |
| `GEMINI_CLI_HOME` | Folder that holds Gemini CLI's `.gemini` directory (default your home folder) |
| `CTXPOOL_ANTIGRAVITY_DIR` | Antigravity CLI data for ContextPool to read (default `~/.gemini/antigravity-cli`). `agy` itself ignores it. |
| `CTXPOOL_EDITOR` | Editor command for "open file" in the UI |
| `NO_COLOR` | Plain terminal output |

## Privacy and security

- Data lives in `~/.ctxpool` with owner-only permissions. Nothing is sent anywhere.
- Secrets are redacted at capture, and again on team export for packets saved by older versions.
- The UI binds to `127.0.0.1`. It rejects requests addressed to other hostnames (DNS rebinding), cross-origin writes, and non-JSON writes. File previews are limited to repositories in saved handoffs and do not follow symlinks out of them.

Report security issues privately; see [SECURITY.md](SECURITY.md).

Agent logos in the UI are trademarks of their owners and are shown only to identify where a session came from. The UI uses the Geist typeface (SIL Open Font License).

## Development

Requires Node.js 22.13 or later. The store uses the built-in `node:sqlite`.

```sh
npm install
npm run typecheck
npm test
npm run build
CTXPOOL_HOME=.ctxpool-test npm run dev -- handoff
```

## License

MIT
