#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { Command, InvalidArgumentError, Option } from "commander";
import { copyToClipboard } from "./clipboard.js";
import { glyph, heading, line, note, plural, print, printError, relativeTime, rows, style, table, tildePath } from "./format.js";
import { buildTeamTimelineExport, createHandoff } from "./handoff.js";
import { DEFAULT_CONFIG, ensureCtxDirs, getCtxPaths, loadConfig } from "./paths.js";
import { gitTopLevel } from "./repo.js";
import { claudeHome, codexHome, listSessionCandidates, sourceLabel, type SessionFrom } from "./session.js";
import { openStore } from "./store.js";
import { formatTokens } from "./text.js";
import type { HandoffPacket } from "./types.js";
import { CtxError } from "./util.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("ctxpool")
  .description("Hand off AI coding sessions between Codex, Claude, and any MCP-capable agent.")
  .version(VERSION, "-v, --version", "Show the version")
  .helpOption("-h, --help", "Show help")
  .helpCommand(false)
  .showHelpAfterError(style.dim("(run ctxpool --help for usage)"))
  .configureHelp({
    sortSubcommands: false,
    styleTitle: (text) => style.bold(text),
    styleDescriptionText: (text) => style.dim(text),
    styleOptionTerm: (text) => text,
    styleSubcommandTerm: (text) => text
  })
  .configureOutput({ outputError: (text, write) => write(`${style.red(text.trimEnd())}\n`) })
  .addHelpText(
    "after",
    [
      "",
      style.bold("Examples:"),
      `  ctxpool handoff               ${style.dim("Hand off the latest session in this repo")}`,
      `  ctxpool handoff --from codex  ${style.dim("Choose when both agents were active")}`,
      `  ctxpool sessions              ${style.dim("See which sessions ContextPool can read")}`,
      `  ctxpool ui                    ${style.dim("Curate reusable context packs in the browser")}`,
      ""
    ].join("\n")
  );

program.action(() => program.help());

const fromOption = () =>
  new Option("--from <agent>", "Source agent").choices(["auto", "codex", "claude"]).default("auto");
const budgetOption = () => new Option("--budget <tokens>", "Token budget for the transcript excerpt").argParser(positiveInt);

type CaptureOptions = {
  task?: string;
  from: SessionFrom;
  session?: string;
  transcript: boolean;
  to?: string;
  budget?: number;
  ollama?: boolean;
  open?: boolean;
  json?: boolean;
};

program
  .command("handoff")
  .description("Capture the current session and copy a handoff to the clipboard")
  .option("--task <name>", "Task name (defaults to the branch or repo name)")
  .addOption(fromOption())
  .option("--session <id|path>", "Use a specific session id or .jsonl file")
  .option("--to <agent>", "Name the agent that will pick this up")
  .option("--no-transcript", "Leave the recent transcript out of the handoff")
  .addOption(budgetOption())
  .option("--ollama", "Ask a local Ollama model to phrase the next action")
  .addOption(new Option("--no-ollama").hideHelp())
  .option("--open", "Open the UI afterwards")
  .option("--json", "Print machine-readable output")
  .action(async (options: CaptureOptions) => {
    const packet = await capture(options);
    const copied = copyToClipboard(packet.markdown);
    if (options.json) return printJson({ ...packetJson(packet), copied });
    printHandoff(packet, copied ? "copied" : "saved");
    if (options.open) await runUi({ open: true });
  });

program
  .command("capture")
  .description("Capture the current session without touching the clipboard")
  .option("--task <name>", "Task name (defaults to the branch or repo name)")
  .addOption(fromOption())
  .option("--session <id|path>", "Use a specific session id or .jsonl file")
  .option("--no-transcript", "Leave the recent transcript out of the handoff")
  .addOption(budgetOption())
  .option("--ollama", "Ask a local Ollama model to phrase the next action")
  .addOption(new Option("--no-ollama").hideHelp())
  .option("--json", "Print machine-readable output")
  .action(async (options: CaptureOptions) => {
    const packet = await capture(options);
    if (options.json) return printJson(packetJson(packet));
    printHandoff(packet, "captured");
  });

program
  .command("sessions")
  .description("List the Codex and Claude sessions ContextPool can read")
  .addOption(fromOption())
  .option("--all", "Include sessions from other folders")
  .option("-n, --limit <count>", "How many to show", positiveInt, 10)
  .option("--json", "Print machine-readable output")
  .action((options: { from: SessionFrom; all?: boolean; limit: number; json?: boolean }) => {
    const cwd = process.cwd();
    const repoRoot = gitTopLevel(cwd);
    const candidates = listSessionCandidates({ cwd, repoRoot, from: options.from });
    const visible = (options.all ? candidates : candidates.filter((candidate) => candidate.matchedCwd)).slice(0, options.limit);
    if (options.json) return printJson(visible);

    const place = basename(repoRoot || cwd);
    if (!visible.length) {
      return print([
        heading("No sessions here", place),
        "",
        note(candidates.length ? "Other folders have sessions. Run `ctxpool sessions --all` to see them." : `Looked in ${tildePath(codexHome())} and ${tildePath(claudeHome())}.`)
      ]);
    }
    const pick = visible.find((candidate) => candidate.matchedCwd);
    print([
      heading("Sessions", options.all ? "all folders" : place),
      "",
      ...table(
        visible.map((candidate) => [
          candidate === pick ? glyph.active : " ",
          sourceLabel(candidate.source),
          truncateCell(candidate.title || style.dim("Untitled"), 44),
          style.dim(relativeTime(candidate.updatedAt)),
          style.dim(candidate.id.slice(0, 8)),
          ...(options.all ? [style.dim(candidate.matchedCwd ? "this repo" : tildePath(candidate.cwd || "unknown"))] : [])
        ])
      ),
      "",
      pick ? note("● is what `ctxpool handoff` will use.") : note("None of these ran in this folder. Pass --session <id> to pick one.")
    ]);
  });

program
  .command("tasks")
  .description("List tasks with saved handoffs")
  .option("--json", "Print machine-readable output")
  .action((options: { json?: boolean }) =>
    withStore((store) => {
      const tasks = store.listTasks();
      if (options.json) return printJson(tasks);
      if (!tasks.length) return print([heading("No handoffs yet"), "", note("Run `ctxpool handoff` in a repo where you've used Codex or Claude.")]);
      print([
        heading("Tasks"),
        "",
        ...table(tasks.map((task) => [task.task, style.dim(plural(task.handoffCount, "handoff")), style.dim(relativeTime(task.latestAt))]))
      ]);
    })
  );

program
  .command("show")
  .description("Print a saved handoff")
  .argument("[task]", "Task name, or `latest`", "latest")
  .option("--task <name>", "Task name")
  .option("--json", "Print the full packet as JSON")
  .action((target: string, options: { task?: string; json?: boolean }) =>
    withStore((store) => {
      const task = options.task || (target === "latest" ? undefined : target);
      const handoff = store.getLatestHandoff(task);
      if (!handoff) throw new CtxError(task ? `No handoff found for "${task}".` : "No handoffs yet.", "Run `ctxpool handoff` to capture one, or `ctxpool tasks` to list tasks.");
      if (options.json) return printJson(handoff);
      process.stdout.write(`${handoff.markdown}\n`);
    })
  );

program
  .command("status")
  .description("Show where ContextPool keeps data and what it can see")
  .option("--json", "Print machine-readable output")
  .action((options: { json?: boolean }) =>
    withStore((store) => {
      const status = store.getStatus();
      const agents = { codex: existsSync(join(codexHome(), "sessions")), claude: existsSync(join(claudeHome(), "projects")) };
      if (options.json) return printJson({ version: VERSION, ...status, agents });
      print([
        heading("ContextPool", VERSION),
        "",
        ...rows([
          ["Store", tildePath(status.home)],
          ["Tasks", String(status.taskCount)],
          ["Handoffs", String(status.handoffCount)],
          ["Packs", String(status.packCount)],
          ["Agents", `${agents.claude ? glyph.ok : glyph.idle} Claude   ${agents.codex ? glyph.ok : glyph.idle} Codex`]
        ])
      ]);
    })
  );

program
  .command("init")
  .description("Create the local store and config")
  .action(() =>
    withStore(() => {
      const paths = ensureCtxDirs();
      if (!existsSync(paths.configPath)) writeFileSync(paths.configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
      print([line(`${glyph.ok} ContextPool is ready`), note(`  ${tildePath(paths.home)}`), "", note("Next: run `ctxpool handoff` in a repo where you've used Codex or Claude.")]);
    })
  );

program
  .command("ui")
  .description("Open the context pack builder in your browser")
  .option("--host <host>", "Host to bind")
  .option("--port <port>", "Port to bind", positiveInt)
  .option("--open", "Open the browser")
  .action((options: { host?: string; port?: number; open?: boolean }) => runUi(options));

const team = program.command("team").description("Share handoffs with a team");
team
  .command("export")
  .description("Write the latest handoff as a redacted, sync-ready JSON packet")
  .option("--task <name>", "Task name")
  .option("--out <path>", "Output file")
  .option("--include-transcript", "Include the raw transcript", false)
  .option("--json", "Print machine-readable output")
  .action((options: { task?: string; out?: string; includeTranscript: boolean; json?: boolean }) =>
    withStore((store) => {
      const paths = ensureCtxDirs();
      const handoff = store.getLatestHandoff(options.task);
      if (!handoff) throw new CtxError(options.task ? `No handoff found for "${options.task}".` : "No handoffs yet.", "Run `ctxpool handoff` first.");
      const exported = buildTeamTimelineExport(handoff, { includeRawTranscript: options.includeTranscript });
      const outPath = options.out || join(paths.teamExportsDir, exported.task, `${exported.id}.json`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(exported, null, 2), { encoding: "utf8", mode: 0o600 });
      if (options.json) return printJson({ task: exported.task, path: outPath, transcript: exported.engineeringMemory?.teamSync.rawTranscript });
      print([
        line(`${glyph.ok} ${style.bold("Team export ready")}`),
        "",
        ...rows([
          ["Task", exported.task],
          ["Transcript", exported.engineeringMemory?.teamSync.rawTranscript === "included" ? `${glyph.warn} included` : "excluded"],
          ["Secrets", "redacted"],
          ["Saved", tildePath(outPath)]
        ])
      ]);
    })
  );

const mcp = program
  .command("mcp")
  .description("Serve handoffs to agents over MCP")
  .addHelpText(
    "after",
    [
      "",
      style.bold("Connect an agent:"),
      "  claude mcp add contextpool -- npx -y ctxpool mcp start",
      "  codex mcp add contextpool -- npx -y ctxpool mcp start",
      ""
    ].join("\n")
  );
mcp.action(() => mcp.help());
mcp
  .command("start")
  .description("Start the stdio MCP server")
  .action(async () => {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer();
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CtxError) {
    printError(error.message, error.hint);
  } else {
    printError(error instanceof Error ? error.message : String(error), process.env.CTXPOOL_DEBUG ? undefined : "Set CTXPOOL_DEBUG=1 for details.");
    if (process.env.CTXPOOL_DEBUG && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});

// ---------------------------------------------------------------------------

async function capture(options: CaptureOptions): Promise<HandoffPacket> {
  const config = loadConfig();
  const packet = await createHandoff({
    task: options.task,
    from: options.from,
    session: options.session,
    includeTranscript: options.transcript,
    to: options.to,
    budget: options.budget,
    useOllama: options.ollama ?? config.ollama.enabled,
    ollamaModel: config.ollama.model
  });
  await withStore((store) => store.saveHandoff(packet));
  return packet;
}

function printHandoff(packet: HandoffPacket, outcome: "copied" | "saved" | "captured"): void {
  const summary = packet.handoffSummary!;
  const session = packet.sourceSession;
  const stats = summary.repoStats;
  const checks = summary.verification.commands
    .slice(-3)
    .map((command) => `${command.status === "passed" ? glyph.ok : command.status === "failed" ? glyph.fail : glyph.unknown} ${truncateCell(command.command, 60)}`);
  const repoLine = [
    basename(packet.repo.repoPath),
    packet.repo.isGitRepo ? `${packet.repo.branch} @ ${packet.repo.commit}` : "not a git repo",
    stats.dirtyFiles ? `${plural(stats.dirtyFiles, "file")} ${style.green(`+${stats.additions}`)} ${style.red(`-${stats.deletions}`)}` : "clean"
  ].join(style.dim(" · "));

  const footer =
    outcome === "copied"
      ? `${glyph.ok} Copied to clipboard ${style.dim(`· ~${formatTokens(packet.tokenEstimate || 0)} tokens`)}`
      : outcome === "saved"
        ? `${glyph.warn} Clipboard unavailable ${style.dim("· saved to disk")}`
        : `${glyph.ok} Saved ${style.dim(`· ~${formatTokens(packet.tokenEstimate || 0)} tokens`)}`;

  print([
    heading(outcome === "captured" ? "Captured" : "Handoff ready"),
    "",
    ...rows([
      ["Task", packet.task],
      ["Source", session ? [sourceLabel(session.source), session.threadName, relativeTime(session.updatedAt)].filter(Boolean).join(style.dim(" · ")) : undefined],
      ["Repo", repoLine],
      ["Phase", summary.workPhase],
      ...checks.map((check, index): [string, string] => [index === 0 ? "Checks" : "", check]),
      ...(checks.length ? [] : [["Checks", style.dim("none recorded")] as [string, string]]),
      ["Next", summary.nextAction]
    ]),
    session && !session.matchedCwd ? ["", line(`${glyph.warn} ${style.dim(`This session ran in ${tildePath(session.cwd || "another folder")}, not here.`)}`)].join("\n") : undefined,
    "",
    line(footer),
    note(`  ${tildePath(packet.markdownPath)}`)
  ]);
}

function packetJson(packet: HandoffPacket) {
  const summary = packet.handoffSummary!;
  return {
    id: packet.id,
    task: packet.task,
    path: packet.markdownPath,
    tokens: packet.tokenEstimate,
    phase: summary.workPhase,
    nextAction: summary.nextAction,
    verification: summary.verification,
    source: packet.sourceSession ? { agent: packet.sourceSession.source, id: packet.sourceSession.id, title: packet.sourceSession.threadName } : undefined
  };
}

async function runUi(options: { host?: string; port?: number; open?: boolean }): Promise<void> {
  const config = loadConfig();
  const { startUi } = await import("./ui.js");
  const ui = await startUi({ host: options.host || config.ui.host, port: options.port ?? config.ui.port, fallback: options.port === undefined });
  const exposed = !["127.0.0.1", "localhost", "::1"].includes(ui.host);
  print([
    heading("ContextPool UI"),
    "",
    ...rows([
      ["Local", ui.url],
      ["Store", tildePath(getCtxPaths().home)]
    ]),
    exposed ? ["", line(`${glyph.warn} ${style.dim("Bound beyond localhost. Anyone on this network can read your handoffs.")}`)].join("\n") : undefined,
    "",
    note("Press Ctrl+C to stop.")
  ]);
  if (options.open) openBrowser(ui.url);
  const stop = () => void ui.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
}

async function withStore<T>(fn: (store: Awaited<ReturnType<typeof openStore>>) => T): Promise<T> {
  const store = await openStore();
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new InvalidArgumentError("Expected a positive whole number.");
  return parsed;
}

function truncateCell(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
