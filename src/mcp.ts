import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildAgentContext, buildTeamTimelineExport } from "./handoff.js";
import { renderContextPackOutput } from "./pack.js";
import { openStore, type CtxStore } from "./store.js";
import { VERSION } from "./version.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const INSTRUCTIONS = [
  "ContextPool holds handoff packets captured from earlier Codex, Claude, and Gemini sessions: the objective, plan, verification results, changed files, and next action.",
  "When continuing work in a repository, call get_latest_agent_context (or get_handoff_by_task) first and start from its Next action.",
  "Everything is local and read-only. Secrets are redacted at capture."
].join(" ");

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "contextpool", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_latest_handoff",
    {
      title: "Get latest handoff",
      description: "Return the most recent handoff as markdown. Optionally filter by task.",
      inputSchema: { task: z.string().optional() },
      annotations: READ_ONLY
    },
    ({ task }) =>
      withStore((store) => {
        const handoff = store.getLatestHandoff(task);
        return handoff ? text(handoff.markdown) : notFound(task ? `No handoff found for task "${task}".` : "No handoff found. Ask the user to run `ctxpool handoff`.");
      })
  );

  server.registerTool(
    "get_handoff_by_task",
    {
      title: "Get handoff by task",
      description: "Return the latest handoff for a task as markdown.",
      inputSchema: { task: z.string() },
      annotations: READ_ONLY
    },
    ({ task }) =>
      withStore((store) => {
        const handoff = store.getLatestHandoff(task);
        return handoff ? text(handoff.markdown) : notFound(`No handoff found for task "${task}".`);
      })
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List tasks with handoffs, newest first, with handoff counts and latest timestamps.",
      inputSchema: {},
      annotations: READ_ONLY
    },
    () => withStore((store) => json(store.listTasks()))
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Get task status",
      description: "Return a compact JSON status for a task's latest handoff: next action, blockers, and touched files.",
      inputSchema: { task: z.string() },
      annotations: READ_ONLY
    },
    ({ task }) =>
      withStore((store) => {
        const latest = store.listHandoffs(task)[0];
        return latest ? json(latest) : notFound(`No handoff found for task "${task}".`);
      })
  );

  server.registerTool(
    "get_latest_agent_context",
    {
      title: "Get latest agent context",
      description: "Return the latest handoff as import-ready markdown plus a structured summary (plan, verification, changed files). Excludes the raw transcript.",
      inputSchema: { task: z.string().optional() },
      annotations: READ_ONLY
    },
    ({ task }) =>
      withStore((store) => {
        const handoff = store.getLatestHandoff(task);
        if (!handoff) return notFound(task ? `No handoff found for task "${task}".` : "No handoff found.");
        const { markdown, summary } = buildAgentContext(handoff);
        return json({ markdown, summary });
      })
  );

  server.registerTool(
    "get_handoff_files",
    {
      title: "Get handoff files",
      description: "Return the structured file changes (path, status, additions, deletions) from a task's latest handoff.",
      inputSchema: { task: z.string().optional() },
      annotations: READ_ONLY
    },
    ({ task }) =>
      withStore((store) => {
        const handoff = store.getLatestHandoff(task);
        return handoff ? json(handoff.handoffSummary?.fileChanges || []) : notFound("No handoff found.");
      })
  );

  server.registerTool(
    "get_team_timeline_packet",
    {
      title: "Get team timeline packet",
      description: "Return the latest handoff as a redacted, sync-ready packet. The raw transcript is excluded unless includeRawTranscript is true.",
      inputSchema: { task: z.string().optional(), includeRawTranscript: z.boolean().optional() },
      annotations: READ_ONLY
    },
    ({ task, includeRawTranscript }) =>
      withStore((store) => {
        const handoff = store.getLatestHandoff(task);
        return handoff ? json(buildTeamTimelineExport(handoff, { includeRawTranscript })) : notFound("No handoff found.");
      })
  );

  server.registerTool(
    "list_context_packs",
    {
      title: "List context packs",
      description: "List saved context packs: curated, reusable prompt context built in the ContextPool UI.",
      inputSchema: {},
      annotations: READ_ONLY
    },
    () =>
      withStore((store) =>
        json(
          store.listContextPacks().map((pack) => ({
            id: pack.id,
            name: pack.name,
            updatedAt: pack.updatedAt,
            items: pack.items.length,
            enabledItems: pack.items.filter((item) => item.enabled).length
          }))
        )
      )
  );

  server.registerTool(
    "get_context_pack",
    {
      title: "Get context pack",
      description: "Return a saved context pack as markdown (default) or JSON.",
      inputSchema: { id: z.string(), format: z.enum(["markdown", "json"]).optional() },
      annotations: READ_ONLY
    },
    ({ id, format }) =>
      withStore((store) => {
        const pack = store.getContextPackById(id);
        if (!pack) return notFound(`No context pack found with id "${id}".`);
        const output = renderContextPackOutput(pack);
        return format === "json" ? json(output.json) : text(output.markdown);
      })
  );

  await server.connect(new StdioServerTransport());
}

async function withStore(fn: (store: CtxStore) => ToolResult): Promise<ToolResult> {
  const store = await openStore();
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

function notFound(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
