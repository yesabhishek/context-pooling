#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { copyToClipboard } from "./clipboard.js";
import { buildTeamTimelineExport, createHandoff } from "./handoff.js";
import { discoverAgentSignals } from "./logs.js";
import { ensureCtxDirs, getCtxPaths } from "./paths.js";
import { startMcpServer } from "./mcp.js";
import { openStore } from "./store.js";
import { startUi } from "./ui.js";

const program = new Command();

program
  .name("ctxpool")
  .description("Local-first handoff packets for AI coding agents.")
  .version("0.1.0");

program.command("init").description("Create the local ContextPool store.").action(async () => {
  const paths = ensureCtxDirs();
  if (!existsSync(paths.configPath)) {
    writeFileSync(
      paths.configPath,
      JSON.stringify(
        {
          version: 1,
          ui: { host: "127.0.0.1", port: 4377 },
          ollama: { model: process.env.CTXPOOL_OLLAMA_MODEL || "llama3.1" }
        },
        null,
        2
      )
    );
  }
  const store = await openStore();
  store.close();
  console.log(`ContextPool initialized at ${paths.home}`);
});

program
  .command("handoff")
  .description("Capture repo/task state and create a handoff packet.")
  .option("--task <task>", "Task name. Defaults to git branch or repo name.")
  .option("--from <agent>", "Source agent to export from: auto, codex, claude.", "auto")
  .option("--session <id-or-path>", "Specific source session id or JSONL path.")
  .option("--no-transcript", "Do not include the transcript excerpt in the markdown.")
  .option("--to <agent>", "Target agent label, e.g. claude, codex, cursor.")
  .option("--budget <tokens>", "Reserved for future token budgeting.", parseInt)
  .option("--open", "Start the local observability UI after creating the handoff.")
  .option("--no-ollama", "Skip optional Ollama enhancement.")
  .action(async (options: { task?: string; from?: "auto" | "codex" | "claude"; session?: string; transcript?: boolean; to?: string; budget?: number; open?: boolean; ollama?: boolean }) => {
    ensureCtxDirs();
    const packet = await createHandoff({
      task: options.task,
      from: options.from,
      session: options.session,
      includeTranscript: options.transcript,
      to: options.to,
      budget: options.budget,
      useOllama: options.ollama
    });

    const store = await openStore();
    store.saveHandoff(packet);
    store.close();

    const copied = copyToClipboard(packet.markdown);
    printHandoffResult(packet.task, packet.markdownPath, copied, packet.sections.nextBestAction);

    if (options.open) {
      await startUi();
    }
  });

program
  .command("ui")
  .description("Start the local context builder UI.")
  .option("--host <host>", "Host to bind.", "127.0.0.1")
  .option("--port <port>", "Port to bind.", (value) => parseInt(value, 10))
  .action(async (options: { host: string; port?: number }) => {
    await startUi(options);
  });

program
  .command("capture")
  .description("Capture current repo/task state without copying to clipboard.")
  .option("--task <task>", "Task name. Defaults to git branch or repo name.")
  .option("--from <agent>", "Source agent to export from: auto, codex, claude.", "auto")
  .option("--session <id-or-path>", "Specific source session id or JSONL path.")
  .option("--no-transcript", "Do not include the transcript excerpt in the markdown.")
  .option("--no-ollama", "Skip optional Ollama enhancement.")
  .action(async (options: { task?: string; from?: "auto" | "codex" | "claude"; session?: string; transcript?: boolean; ollama?: boolean }) => {
    const packet = await createHandoff({
      task: options.task,
      from: options.from,
      session: options.session,
      includeTranscript: options.transcript,
      useOllama: options.ollama
    });
    const store = await openStore();
    store.saveHandoff(packet);
    store.close();
    console.log(`Captured ${packet.task}`);
    console.log(`Saved: ${packet.markdownPath}`);
  });

const importCommand = program.command("import").description("Inspect local agent logs.");
importCommand
  .command("codex")
  .description("Inspect recent Codex logs.")
  .option("--path <path>", "Codex sessions directory.")
  .option("--latest", "Only inspect the latest files.", true)
  .action((options: { path?: string; latest?: boolean }) => {
    const signals = discoverAgentSignals({ codexPath: options.path, claudePath: "/__ctxpool_skip_claude__", latest: options.latest });
    printSignals(signals);
  });

importCommand
  .command("claude")
  .description("Inspect recent Claude Code logs.")
  .option("--path <path>", "Claude projects directory.")
  .option("--latest", "Only inspect the latest files.", true)
  .action((options: { path?: string; latest?: boolean }) => {
    const signals = discoverAgentSignals({ codexPath: "/__ctxpool_skip_codex__", claudePath: options.path, latest: options.latest });
    printSignals(signals);
  });

program.command("tasks").description("List known handoff tasks.").action(async () => {
  const store = await openStore();
  try {
    const tasks = store.listTasks();
    if (tasks.length === 0) {
      console.log("No handoff tasks found. Run `ctxpool handoff` first.");
      return;
    }
    for (const task of tasks) {
      console.log(`${task.task}\t${task.handoffCount} handoff(s)\tlatest ${task.latestAt}`);
    }
  } finally {
    store.close();
  }
});

program.command("status").description("Show local ContextPool status.").action(async () => {
  const store = await openStore();
  try {
    const status = store.getStatus();
    console.log(`Home: ${status.home}`);
    console.log(`Database: ${status.dbPath}`);
    console.log(`Team exports: ${status.teamExportsDir}`);
    console.log(`Tasks: ${status.taskCount}`);
    console.log(`Handoffs: ${status.handoffCount}`);
  } finally {
    store.close();
  }
});

const show = program.command("show").description("Show saved handoffs.");
show.command("latest").description("Print the latest handoff packet.").option("--task <task>", "Task name.").action(async (options: { task?: string }) => {
  const store = await openStore();
  try {
    const handoff = store.getLatestHandoff(options.task);
    if (!handoff) {
      console.error("No handoff found. Run `ctxpool handoff` first.");
      process.exitCode = 1;
      return;
    }
    console.log(handoff.markdown);
  } finally {
    store.close();
  }
});

const team = program.command("team").description("Prepare local handoffs for a future ContextPool Team Timeline.");
team
  .command("export")
  .description("Export the latest handoff as a redacted, sync-ready team timeline packet.")
  .option("--task <task>", "Task name.")
  .option("--out <path>", "Output JSON path.")
  .option("--include-transcript", "Include raw transcript entries in the export.", false)
  .action(async (options: { task?: string; out?: string; includeTranscript?: boolean }) => {
    const paths = ensureCtxDirs();
    const store = await openStore();
    try {
      const handoff = store.getLatestHandoff(options.task);
      if (!handoff) {
        console.error("No handoff found. Run `ctxpool handoff` first.");
        process.exitCode = 1;
        return;
      }
      const exported = buildTeamTimelineExport(handoff, { includeRawTranscript: options.includeTranscript });
      const outPath = options.out || join(paths.teamExportsDir, exported.task, `${exported.id}.json`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(exported, null, 2), "utf8");
      console.log("ContextPool team timeline export created");
      console.log("");
      console.log(`Task: ${exported.task}`);
      console.log(`Saved: ${outPath}`);
      console.log(`Raw transcript: ${exported.engineeringMemory?.teamSync.rawTranscript || "excluded"}`);
      console.log(`Sync mode: ${exported.engineeringMemory?.teamSync.mode || "sync-ready"}`);
    } finally {
      store.close();
    }
  });

const mcp = program.command("mcp").description("Run the ContextPool MCP server.");
mcp.command("start").description("Start the stdio MCP server.").action(async () => {
  await startMcpServer();
});

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function printHandoffResult(task: string, markdownPath: string, copied: boolean, nextBestAction: string): void {
  console.log("ContextPool handoff created");
  console.log("");
  console.log(`Task: ${task}`);
  console.log(`Copied: ${copied ? "yes" : "no"}`);
  console.log(`Saved: ${markdownPath}`);
  console.log("");
  console.log("Next best action:");
  console.log(nextBestAction);
}

function printSignals(signals: ReturnType<typeof discoverAgentSignals>): void {
  if (signals.length === 0) {
    console.log("No relevant agent log signals found.");
    return;
  }
  for (const signal of signals) {
    console.log(`${signal.source}: ${signal.path}`);
    for (const snippet of signal.snippets.slice(0, 8)) console.log(`  - ${snippet}`);
  }
}
