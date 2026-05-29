# ContextPool

ContextPool is a local-first context builder for AI-assisted engineering work.

It captures handoff packets from Codex and Claude sessions, preserves repo state and provenance, then lets you drag reusable context blocks into agent-ready prompt packs for Codex, Claude, Cursor, or any MCP-capable tool.

## Why

AI coding sessions often lose the useful parts of prior work: task intent, decisions, constraints, files changed, verification state, blockers, and the next best action. ContextPool keeps that engineering memory local, structured, and reusable.

The wedge is not generic long-term memory. It is provenance-backed engineering continuity:

- Capture what changed, why it changed, what was verified, what failed, and what should happen next.
- Preserve local-first trust by default.
- Let users curate exactly which context goes into the next agent prompt.
- Export sync-ready packets only when the user chooses.

## Features

- Local handoff capture from Codex and Claude JSONL sessions.
- Git snapshot capture: branch, commit, dirty files, diff stats, patches, and recent commits.
- Drag-and-drop context pack builder UI.
- Reusable context blocks for intent, instructions, decisions, constraints, verification, risks, next actions, files, and transcript snippets.
- Markdown and JSON prompt-pack export.
- Local SQL.js storage under `~/.ctxpool` by default.
- MCP tools for agents to read handoffs and curated context packs.
- Redacted team timeline export with raw transcripts excluded by default.

## Install

Requires Node.js `>=22.5.0`.

```sh
npm install -g ctxpool
ctxpool init
```

For one-off usage without a global install:

```sh
npx ctxpool --help
```

## Quick Start

Capture a handoff from the current workspace:

```sh
ctxpool handoff --from codex --no-ollama
```

Open the local context builder UI:

```sh
ctxpool ui
```

Then open:

```text
http://127.0.0.1:4377
```

If the default port is busy, `ctxpool ui` tries the next few ports automatically unless a fixed `--port` is provided.

## Context Packs

The UI turns saved handoffs into draggable context blocks. Add the useful blocks to a context pack, reorder them, disable noisy entries, and copy the generated markdown or JSON into another agent.

Raw transcript text is redacted by default in context packs. Enable raw transcript export only when the destination is trusted.

Saved packs stay local in the ContextPool store.

## CLI

```sh
ctxpool init
ctxpool handoff --from codex --no-ollama
ctxpool capture --from claude --task billing-flow
ctxpool ui
ctxpool tasks
ctxpool show latest --task billing-flow
ctxpool team export --task billing-flow
ctxpool mcp start
```

`ctxpool team export` writes a sync-ready JSON packet under the local ContextPool home directory. Raw transcript entries are excluded by default:

```sh
ctxpool team export --task my-task
ctxpool team export --task my-task --include-transcript
```

## MCP Tools

ContextPool exposes local MCP tools for agents:

- `get_latest_handoff`
- `get_handoff_by_task`
- `list_tasks`
- `get_task_status`
- `get_latest_agent_context`
- `get_handoff_files`
- `get_team_timeline_packet`
- `list_context_packs`
- `get_context_pack`

`get_team_timeline_packet` returns a sync-ready packet with raw transcripts excluded unless explicitly requested. `get_context_pack` returns a curated prompt pack as markdown by default or JSON when requested.

## Privacy and Security

- ContextPool is local-first. It stores data under `~/.ctxpool` unless `CTXPOOL_HOME` is set.
- Handoff packets can include repo paths, diffs, transcript excerpts, and command output. Review exports before sharing.
- Raw transcripts are excluded from team exports by default.
- Context pack transcript blocks are redacted by default.
- The UI binds to `127.0.0.1` by default. Avoid binding to public interfaces unless you understand the local-file exposure risk.
- File preview/open APIs are restricted to repositories already captured in saved handoffs.

Security issues should be reported privately; see `SECURITY.md`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

When working from source, run CLI commands through the development entrypoint:

```sh
CTXPOOL_HOME=.ctxpool-test npm run dev -- ui
npm run dev -- --version
```

## Release Checks

Before publishing:

```sh
npm test
npm run typecheck
npm run build
npm audit --omit=dev
npm pack --dry-run
```

Confirm the package contents include only intentional release files and no local stores, databases, logs, transcripts, or secrets.

## License

MIT
