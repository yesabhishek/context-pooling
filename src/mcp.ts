import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildAgentContext, buildTeamTimelineExport, renderContextPackOutput } from "./handoff.js";
import { openStore } from "./store.js";

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "contextpool",
    version: "0.1.1"
  });

  server.registerTool(
    "get_latest_handoff",
    {
      title: "Get latest handoff",
      description: "Return the latest ContextPool handoff packet. Optionally filter by task.",
      inputSchema: {
        task: z.string().optional()
      }
    },
    async ({ task }) => {
      const store = await openStore();
      try {
        const handoff = store.getLatestHandoff(task);
        return {
          content: [
            {
              type: "text",
              text: handoff?.markdown || "No ContextPool handoff found. Ask the user to run `ctxpool handoff`."
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  server.registerTool(
    "get_handoff_by_task",
    {
      title: "Get handoff by task",
      description: "Return the latest handoff packet for a specific task.",
      inputSchema: {
        task: z.string()
      }
    },
    async ({ task }) => {
      const store = await openStore();
      try {
        const handoff = store.getLatestHandoff(task);
        return {
          content: [
            {
              type: "text",
              text: handoff?.markdown || `No ContextPool handoff found for task "${task}".`
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List handoff tasks",
      description: "List known ContextPool tasks and latest handoff timestamps.",
      inputSchema: {}
    },
    async () => {
      const store = await openStore();
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(store.listTasks(), null, 2)
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Get task status",
      description: "Return a concise JSON status summary for the latest handoff of a task.",
      inputSchema: {
        task: z.string()
      }
    },
    async ({ task }) => {
      const store = await openStore();
      try {
        const latest = store.listHandoffs(task)[0];
        return {
          content: [
            {
              type: "text",
              text: latest ? JSON.stringify(latest, null, 2) : `No ContextPool status found for task "${task}".`
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  server.registerTool(
    "get_latest_agent_context",
    {
      title: "Get latest agent context",
      description: "Return the latest ContextPool handoff as import-ready markdown and structured JSON.",
      inputSchema: {
        task: z.string().optional()
      }
    },
    async ({ task }) => {
      const store = await openStore();
      try {
        const handoff = store.getLatestHandoff(task);
        if (!handoff) {
          return {
            content: [
              {
                type: "text",
                text: task ? `No ContextPool handoff found for task "${task}".` : "No ContextPool handoff found."
              }
            ]
          };
        }
        const context = buildAgentContext(handoff);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(context, null, 2)
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  server.registerTool(
    "get_handoff_files",
    {
      title: "Get handoff files",
      description: "Return structured file changes for the latest handoff of a task.",
      inputSchema: {
        task: z.string().optional()
      }
    },
    async ({ task }) => {
      const store = await openStore();
      try {
        const handoff = store.getLatestHandoff(task);
        return {
          content: [
            {
              type: "text",
              text: handoff ? JSON.stringify(handoff.handoffSummary?.fileChanges || [], null, 2) : "[]"
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  server.registerTool(
    "get_team_timeline_packet",
    {
      title: "Get team timeline packet",
      description: "Return the latest handoff as a sync-ready team timeline packet with raw transcript excluded by default.",
      inputSchema: {
        task: z.string().optional(),
        includeRawTranscript: z.boolean().optional()
      }
    },
    async ({ task, includeRawTranscript }) => {
      const store = await openStore();
      try {
        const handoff = store.getLatestHandoff(task);
        return {
          content: [
            {
              type: "text",
              text: handoff ? JSON.stringify(buildTeamTimelineExport(handoff, { includeRawTranscript }), null, 2) : "No ContextPool handoff found."
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  server.registerTool(
    "list_context_packs",
    {
      title: "List context packs",
      description: "List saved ContextPool prompt packs curated from reusable handoff context.",
      inputSchema: {}
    },
    async () => {
      const store = await openStore();
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                store.listContextPacks().map((pack) => ({
                  id: pack.id,
                  name: pack.name,
                  updatedAt: pack.updatedAt,
                  items: pack.items.length,
                  enabledItems: pack.items.filter((item) => item.enabled).length
                })),
                null,
                2
              )
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  server.registerTool(
    "get_context_pack",
    {
      title: "Get context pack",
      description: "Return a saved ContextPool prompt pack as import-ready markdown and structured JSON.",
      inputSchema: {
        id: z.string(),
        format: z.enum(["markdown", "json"]).optional()
      }
    },
    async ({ id, format }) => {
      const store = await openStore();
      try {
        const pack = store.getContextPackById(id);
        if (!pack) {
          return {
            content: [
              {
                type: "text",
                text: `No ContextPool context pack found for id "${id}".`
              }
            ]
          };
        }
        const output = renderContextPackOutput(pack);
        return {
          content: [
            {
              type: "text",
              text: format === "json" ? JSON.stringify(output, null, 2) : output.markdown
            }
          ]
        };
      } finally {
        store.close();
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
