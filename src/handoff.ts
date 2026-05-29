import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentSignal,
  ContextBlock,
  ContextPack,
  ContextPackItem,
  ContextPackOutput,
  ContextSignal,
  EngineeringMemory,
  FileChange,
  GitSnapshot,
  HandoffContinuitySummary,
  HandoffPacket,
  HandoffSections,
  MemoryFact,
  ProvenanceKind,
  SourceSession,
  VerificationSummary,
  VerificationStatus,
  WorkPhase
} from "./types.js";
import { ensureCtxDirs } from "./paths.js";
import { captureGitSnapshot, inferTaskName } from "./repo.js";
import { resolveSessionSource, type SessionFrom } from "./session.js";
import { hashText, limit, slugify, unique } from "./util.js";

export type CreateHandoffOptions = {
  cwd?: string;
  task?: string;
  to?: string;
  from?: SessionFrom;
  session?: string;
  includeTranscript?: boolean;
  budget?: number;
  useOllama?: boolean;
};

export async function createHandoff(options: CreateHandoffOptions = {}): Promise<HandoffPacket> {
  const cwd = options.cwd || process.cwd();
  const paths = ensureCtxDirs();
  const repo = captureGitSnapshot(cwd);
  const task = inferTaskName(options.task, repo);
  const sourceSession = resolveSessionSource({
    from: options.from || "auto",
    cwd,
    session: options.session,
    budget: options.budget
  });
  const sources = sourceSessionToSignals(sourceSession);
  const sections = buildSections(task, repo.dirtyFiles, repo.diffStat, sourceSession);
  const handoffSummary = buildHandoffSummary(task, repo, sourceSession, sections);
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${hashText(`${task}:${createdAt}`)}`;

  if (options.useOllama !== false) {
    const improved = await improveWithOllama(task, sections).catch(() => undefined);
    if (improved) {
      sections.nextBestAction = improved;
      handoffSummary.nextAction = improved;
    }
  }

  const engineeringMemory = buildEngineeringMemory(task, repo, sourceSession, id, handoffSummary);

  const markdown = renderHandoffMarkdown({
    id,
    task,
    createdAt,
    targetAgent: options.to,
    repo,
    sources,
    sourceSession,
    sections,
    handoffSummary,
    engineeringMemory,
    markdown: "",
    markdownPath: ""
  }, options.includeTranscript !== false);

  const taskDir = join(paths.handoffsDir, slugify(task));
  mkdirSync(taskDir, { recursive: true });
  const markdownPath = join(taskDir, `${createdAt.replace(/[:.]/g, "-")}.md`);
  writeFileSync(markdownPath, markdown, "utf8");

  return {
    id,
    task,
    createdAt,
    targetAgent: options.to,
    repo,
    sources,
    sourceSession,
    sections,
    handoffSummary,
    engineeringMemory,
    markdown,
    markdownPath
  };
}

export function buildSections(task: string, filesTouched: string[], diffStat: string, sourceSessionOrSources: SourceSession | AgentSignal[]): HandoffSections {
  const sourceSession = Array.isArray(sourceSessionOrSources) ? undefined : sourceSessionOrSources;
  const sources = Array.isArray(sourceSessionOrSources) ? sourceSessionOrSources : sourceSessionToSignals(sourceSessionOrSources);
  const messageSnippets = sourceSession
    ? sourceSession.transcript.filter((entry) => entry.role !== "tool").flatMap((entry) => segmentText(entry.text)).map(toHandoffSignal).filter(Boolean)
    : sources.flatMap((source) => source.snippets);
  const toolSnippets = sourceSession
    ? sourceSession.transcript.filter((entry) => entry.role === "tool").flatMap((entry) => segmentText(entry.text)).map(toHandoffSignal).filter(Boolean)
    : [];
  const operationalSnippets = [...messageSnippets, ...toolSnippets];
  const completed = match(messageSnippets, /(done|completed|fixed|implemented|added|created|updated|changed)/i, 8);
  const todos = match(messageSnippets, /(todo|need to|remaining|follow.?up|please implement|implement this plan|make sure|fix\b|add\b|replace\b|update\b|continue\b)/i, 10);
  const blockers = match(messageSnippets, /(blocked|blocker|stuck|missing|cannot|can't|failed because|error|failure)/i, 8);
  const errors = match(operationalSnippets, /(error|failed|failure|exception|traceback|test failed|build failed)/i, 8);
  const decisions = match(messageSnippets, /(decision|decided|use |prefer |do not|don't|avoid)/i, 8);
  const commandsRun = match(toolSnippets, /\b(npm|pnpm|yarn|bun|git|node|tsx|tsc|vitest|pytest|cargo|go test)\b/i, 12);
  const transcriptFiles = extractFilePaths(messageSnippets);
  const mergedFilesTouched = limit(unique([...filesTouched, ...transcriptFiles]), 40);
  const next = todos[0] || blockers[0] || "Review the changed files, run the relevant tests, and continue from the current git diff.";

  return {
    goal: `Continue the ${task} task without re-discovering prior context.`,
    currentStatus: limit(
      [
        filesTouched.length > 0 ? `${filesTouched.length} dirty file(s) are present in the working tree.` : "No dirty files were detected in the working tree.",
        diffStat ? `Current diff summary: ${diffStat.split("\n").join("; ")}` : "No diff stat is available.",
        sourceSession
          ? `Exported ${sourceSession.transcript.length} transcript item(s) from ${sourceSession.source} session ${sourceSession.id}.`
          : sources.length > 0 ? `Imported signals from ${sources.length} recent agent log file(s).` : "No recent Codex or Claude log signals were found."
      ],
      6
    ),
    completed,
    inProgress: limit([...todos.slice(0, 4), ...mergedFilesTouched.slice(0, 6).map((file) => `Work appears active around ${file}.`)], 8),
    todos,
    blockers,
    filesTouched: mergedFilesTouched,
    commandsRun,
    errors,
    decisions,
    doNotRepeat: match(messageSnippets, /(do not|don't|avoid|never|not repeat|already tried)/i, 8),
    nextBestAction: next
  };
}

export function renderHandoffMarkdown(packet: Omit<HandoffPacket, "markdownPath"> & { markdownPath: string }, includeTranscript = true): string {
  const normalized = normalizeHandoffPacket(packet);
  const summary = normalized.handoffSummary;
  const sourceLines = packet.sources.map((source) => `- ${source.source}: ${source.path} (${source.modifiedAt})`);
  const session = packet.sourceSession;
  return [
    `# Handoff: ${packet.task}`,
    "",
    `Generated: ${packet.createdAt}`,
    packet.targetAgent ? `Target agent: ${packet.targetAgent}` : "",
    "",
    "## Original Question",
    summary?.originalQuestion || "Not captured.",
    "",
    "## Latest User Instruction",
    summary?.latestUserInstruction || "Not captured.",
    "",
    "## Current State",
    summary ? renderCurrentState(summary) : "Not captured.",
    "",
    "## AI Plan",
    summary?.agentPlan || "Not captured.",
    "",
    "## Goal",
    packet.sections.goal,
    "",
    "## What Changed",
    list(formatFileChanges(summary?.fileChanges || [])),
    "",
    "## Current Status",
    list(packet.sections.currentStatus),
    "",
    "## Completed",
    list(packet.sections.completed),
    "",
    "## In Progress",
    list(packet.sections.inProgress),
    "",
    "## Leftover Work",
    list(summary?.remainingWork || packet.sections.todos),
    "",
    "## Blockers",
    list(packet.sections.blockers),
    "",
    "## Files Touched",
    list(packet.sections.filesTouched),
    "",
    "## Commands Run",
    list(packet.sections.commandsRun),
    "",
    "## Verification",
    summary ? renderVerification(summary.verification) : "- Unknown.",
    "",
    "## Errors and Test Failures",
    list(packet.sections.errors),
    "",
    "## Important Decisions",
    list(packet.sections.decisions),
    "",
    "## Do Not Repeat",
    list(packet.sections.doNotRepeat),
    "",
    "## Engineering Memory",
    normalized.engineeringMemory ? renderEngineeringMemory(normalized.engineeringMemory) : "- Not captured.",
    "",
    "## Next Best Action",
    summary?.nextAction || packet.sections.nextBestAction,
    "",
    "## Source Session",
    ...(session
      ? [
          `- Agent: ${session.source}`,
          `- Session ID: ${session.id}`,
          `- Session path: ${session.path}`,
          `- Session cwd: ${session.cwd || "unknown"}`,
          `- Matched cwd: ${session.matchedCwd ? "yes" : "no"}`,
          `- Updated: ${session.updatedAt}`,
          `- Transcript items: ${session.transcript.length}`,
          `- Session lines: ${session.lineCount}`,
          ...(session.threadName ? [`- Thread: ${session.threadName}`] : []),
          ...(session.supplementalPaths?.length ? [`- Supplemental paths: ${session.supplementalPaths.join(", ")}`] : [])
        ]
      : sourceLines.length ? sourceLines : ["- None captured."]),
    "",
    ...(includeTranscript
      ? [
          "## Exported Transcript Excerpt",
          session?.transcriptExcerpt || "No transcript excerpt captured.",
          ""
        ]
      : []),
    "",
    "## Source Provenance",
    `- Repo: ${packet.repo.repoPath}`,
    `- Branch: ${packet.repo.branch}`,
    `- Commit: ${packet.repo.commit}`,
    `- Git repo: ${packet.repo.isGitRepo ? "yes" : "no"}`,
    ...sourceLines,
    ""
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function normalizeHandoffPacket(packet: HandoffPacket): HandoffPacket {
  const repo = {
    ...packet.repo,
    fileChanges: packet.repo.fileChanges?.length ? packet.repo.fileChanges : legacyFileChanges(packet.repo.dirtyFiles || [])
  };
  const derivedSummary = buildHandoffSummary(packet.task, repo, packet.sourceSession, packet.sections);
  const existingSummary = packet.handoffSummary;
  const handoffSummary = existingSummary
    ? {
        ...derivedSummary,
        ...existingSummary,
        fileChanges: existingSummary.fileChanges?.length ? existingSummary.fileChanges : derivedSummary.fileChanges,
        verification: existingSummary.verification || derivedSummary.verification,
        repoStats: existingSummary.repoStats || derivedSummary.repoStats,
        contextSignals: existingSummary.contextSignals?.length ? existingSummary.contextSignals : derivedSummary.contextSignals,
        sourceSession: existingSummary.sourceSession || derivedSummary.sourceSession,
        repo: existingSummary.repo || derivedSummary.repo
      }
    : derivedSummary;
  const engineeringMemory = packet.engineeringMemory || buildEngineeringMemory(packet.task, repo, packet.sourceSession, packet.id, handoffSummary);
  return { ...packet, repo, handoffSummary, engineeringMemory };
}

export function buildHandoffSummary(task: string, repo: GitSnapshot, sourceSession: SourceSession | undefined, sections: HandoffSections): HandoffContinuitySummary {
  const fileChanges = repo.fileChanges?.length ? repo.fileChanges : legacyFileChanges(repo.dirtyFiles || []);
  const originalQuestion = sourceSession ? firstUsefulUserMessage(sourceSession) : "";
  const latestUserInstruction = sourceSession ? latestUsefulUserMessage(sourceSession) : "";
  const latestAssistantSummary = sourceSession ? latestAssistantMessage(sourceSession) : "";
  const agentPlan = sourceSession ? latestPlanMessage(sourceSession) : "";
  const verification = inferVerification(sections, sourceSession);
  const repoStats = summarizeRepoStats(fileChanges);
  const remainingWork = meaningfulList(sections.todos, [
    "No explicit leftover work was captured. Review the changed files and run the relevant tests."
  ]);
  const inProgressWork = meaningfulList(
    sections.inProgress.filter((item) => !/^Work appears active around /i.test(item)),
    fileChanges.length ? [`Active work is concentrated in ${fileChanges.length} changed file(s).`] : []
  );

  return {
    version: 1,
    originalQuestion: originalQuestion || `Continue the ${task} task.`,
    latestUserInstruction: latestUserInstruction || originalQuestion || `Continue the ${task} task.`,
    latestAssistantSummary: latestAssistantSummary || "No assistant progress summary was captured.",
    agentPlan: agentPlan || "No explicit AI plan was captured in the source session.",
    workPhase: inferWorkPhase(sections, verification, agentPlan, fileChanges),
    verification,
    repoStats,
    contextSignals: buildContextSignals(sections, latestUserInstruction || originalQuestion, latestAssistantSummary),
    completedWork: meaningfulList(sections.completed, []),
    inProgressWork,
    remainingWork,
    blockers: sections.blockers,
    nextAction: sections.nextBestAction,
    fileChanges,
    commandsRun: sections.commandsRun,
    errors: sections.errors,
    decisions: sections.decisions,
    sourceSession: sourceSession
      ? {
          source: sourceSession.source,
          id: sourceSession.id,
          cwd: sourceSession.cwd,
          matchedCwd: sourceSession.matchedCwd,
          updatedAt: sourceSession.updatedAt,
          transcriptItems: sourceSession.transcript.length
        }
      : undefined,
    repo: {
      repoPath: repo.repoPath,
      branch: repo.branch,
      commit: repo.commit,
      isGitRepo: repo.isGitRepo
    }
  };
}

export function renderAgentContextMarkdown(packet: HandoffPacket): string {
  const normalized = normalizeHandoffPacket(packet);
  const summary = normalized.handoffSummary;
  return [
    `# ContextPool Agent Handoff: ${normalized.task}`,
    "",
    `Generated: ${normalized.createdAt}`,
    `Repo: ${summary?.repo.repoPath || normalized.repo.repoPath}`,
    `Branch/commit: ${normalized.repo.branch}@${normalized.repo.commit}`,
    "",
    "## Original Question",
    summary?.originalQuestion || "Not captured.",
    "",
    "## Latest User Instruction",
    summary?.latestUserInstruction || "Not captured.",
    "",
    "## Current State",
    summary ? renderCurrentState(summary) : "Not captured.",
    "",
    "## AI Plan",
    summary?.agentPlan || "Not captured.",
    "",
    "## Completed",
    list(summary?.completedWork || []),
    "",
    "## In Progress",
    list(summary?.inProgressWork || []),
    "",
    "## Leftover Work",
    list(summary?.remainingWork || []),
    "",
    "## Verification",
    summary ? renderVerification(summary.verification) : "- Unknown.",
    "",
    "## Blockers",
    list(summary?.blockers || []),
    "",
    "## Files Changed",
    list(formatFileChanges(summary?.fileChanges || [])),
    "",
    "## Commands Run",
    list(summary?.commandsRun || []),
    "",
    "## Errors",
    list(summary?.errors || []),
    "",
    "## Engineering Memory",
    normalized.engineeringMemory ? renderEngineeringMemory(normalized.engineeringMemory) : "- Not captured.",
    "",
    "## Next Action",
    summary?.nextAction || normalized.sections.nextBestAction
  ].join("\n");
}

export function buildAgentContext(packet: HandoffPacket): { markdown: string; summary: HandoffContinuitySummary; engineeringMemory: EngineeringMemory; packet: HandoffPacket } {
  const normalized = normalizeHandoffPacket(packet);
  return {
    markdown: renderAgentContextMarkdown(normalized),
    summary: normalized.handoffSummary!,
    engineeringMemory: normalized.engineeringMemory!,
    packet: normalized
  };
}

export function deriveContextBlocks(packet: HandoffPacket): ContextBlock[] {
  const normalized = normalizeHandoffPacket(packet);
  const summary = normalized.handoffSummary!;
  const memory = normalized.engineeringMemory!;
  const source = `${summary.sourceSession?.source || "handoff"}:${summary.sourceSession?.id || normalized.id}`;
  const blocks: ContextBlock[] = [];
  const push = (
    category: ContextBlock["category"],
    title: string,
    text: string,
    provenance: ProvenanceKind,
    confidence: "high" | "medium" | "low",
    provenanceSource = source
  ) => {
    const clean = cleanContextText(text);
    if (!clean || /^None captured\.?$/i.test(clean) || /^Not captured\.?$/i.test(clean)) return;
    blocks.push({
      id: stableId(`${normalized.id}:${category}`, `${title}:${clean}`),
      sourceHandoffId: normalized.id,
      sourceTask: normalized.task,
      sourceCreatedAt: normalized.createdAt,
      category,
      title,
      text: clean,
      provenance: { kind: provenance, confidence, source: provenanceSource },
      estimatedChars: clean.length
    });
  };

  push("intent", "Original question", summary.originalQuestion, "user-authored", "high");
  push("instruction", "Latest user instruction", summary.latestUserInstruction, "user-authored", "high");
  push("next-action", "Next action", summary.nextAction, "ai-inferred", "medium");
  for (const fact of memory.decisions) push("decision", "Decision", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.constraints) push("constraint", "Constraint", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.verification) push("verification", "Verification", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.risks) push("risk", "Risk", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.nextActions.slice(1)) push("next-action", "Remaining work", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.changedFiles) push("changed-file", "Changed file", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);

  for (const entry of normalized.sourceSession?.transcript || []) {
    if (entry.role === "tool") continue;
    const text = cleanContextText(entry.text);
    if (!text || text.length < 20) continue;
    push("transcript", `${labelize(entry.role)} transcript`, text, "transcript-derived", "medium", source);
  }

  return dedupeBlocks(blocks).slice(0, 160);
}

export function createContextPack(name: string, blocks: ContextBlock[] = [], options: { includeRawTranscript?: boolean } = {}): ContextPack {
  const now = new Date().toISOString();
  const id = `pack_${hashText(`${name}:${now}`)}`;
  return {
    id,
    name: name.trim() || "Untitled context pack",
    createdAt: now,
    updatedAt: now,
    includeRawTranscript: options.includeRawTranscript === true,
    items: blocks.map((block, index) => ({
      id: `item_${hashText(`${id}:${block.id}:${index}`)}`,
      blockId: block.id,
      block,
      order: index,
      enabled: true
    }))
  };
}

export function renderContextPackOutput(pack: ContextPack): ContextPackOutput {
  const normalizedPack = normalizeContextPack(pack);
  const warnings = buildPackWarnings(normalizedPack);
  const enabledItems = normalizedPack.items.filter((item) => item.enabled);
  const estimatedChars = enabledItems.reduce((total, item) => total + item.block.text.length, 0);
  const markdown = renderContextPackMarkdown(normalizedPack, enabledItems, estimatedChars, warnings);
  return {
    pack: normalizedPack,
    markdown,
    json: {
      id: normalizedPack.id,
      name: normalizedPack.name,
      createdAt: normalizedPack.createdAt,
      updatedAt: normalizedPack.updatedAt,
      includeRawTranscript: normalizedPack.includeRawTranscript,
      estimatedChars,
      warnings,
      items: enabledItems
    },
    estimatedChars,
    warnings
  };
}

export function normalizeContextPack(pack: ContextPack): ContextPack {
  const includeRawTranscript = pack.includeRawTranscript === true;
  return {
    ...pack,
    includeRawTranscript,
    name: pack.name.trim() || "Untitled context pack",
    items: pack.items
      .map((item, index) => ({
        ...item,
        order: Number.isFinite(item.order) ? item.order : index,
        enabled: item.enabled !== false,
        block: sanitizeBlockForPack(item.block, includeRawTranscript)
      }))
      .sort((a, b) => a.order - b.order)
      .map((item, index) => ({ ...item, order: index }))
  };
}

export function buildTeamTimelineExport(packet: HandoffPacket, options: { includeRawTranscript?: boolean } = {}): HandoffPacket {
  const normalized = normalizeHandoffPacket(packet);
  const includeRawTranscript = options.includeRawTranscript === true;
  const sourceSession = normalized.sourceSession
    ? {
        ...normalized.sourceSession,
        transcript: includeRawTranscript ? normalized.sourceSession.transcript : [],
        transcriptExcerpt: includeRawTranscript ? normalized.sourceSession.transcriptExcerpt : "Raw transcript excluded from team sync export."
      }
    : undefined;
  const sources = includeRawTranscript
    ? normalized.sources
    : normalized.sources.map((source) => ({ ...source, snippets: [] }));
  const engineeringMemory: EngineeringMemory = {
    ...normalized.engineeringMemory!,
    teamSync: {
      mode: "sync-ready",
      rawTranscript: includeRawTranscript ? "included" : "excluded",
      filePreviewRedaction: "enabled",
      secretsRedaction: "enabled",
      userControlledSync: true
    }
  };
  const exportPacket: HandoffPacket = {
    ...normalized,
    sourceSession,
    sources,
    engineeringMemory,
    markdown: "",
    markdownPath: normalized.markdownPath
  };
  return {
    ...exportPacket,
    markdown: renderHandoffMarkdown(exportPacket, includeRawTranscript)
  };
}

function match(snippets: string[], pattern: RegExp, count: number): string[] {
  return limit(snippets.filter((snippet) => pattern.test(snippet)).reverse(), count);
}

function list(values: string[]): string {
  const clean = unique(values);
  if (clean.length === 0) return "- None captured.";
  return clean.map((value) => `- ${value}`).join("\n");
}

function sourceSessionToSignals(session: SourceSession): AgentSignal[] {
  return [
    {
      source: session.source,
      path: session.path,
      modifiedAt: session.updatedAt,
      snippets: session.transcript.map((entry) => entry.text)
    }
  ];
}

function firstUsefulUserMessage(session: SourceSession): string {
  return cleanLongText(session.transcript.find((entry) => entry.role === "user" && toHandoffSignal(entry.text))?.text || "");
}

function latestUsefulUserMessage(session: SourceSession): string {
  const candidates = session.transcript
    .filter((entry) => entry.role === "user")
    .map((entry) => cleanLongText(entry.text))
    .filter(Boolean);
  return candidates.at(-1) || "";
}

function latestAssistantMessage(session: SourceSession): string {
  const candidates = session.transcript
    .filter((entry) => entry.role === "assistant")
    .map((entry) => cleanLongText(entry.text))
    .filter(Boolean);
  return candidates.at(-1) || "";
}

function latestPlanMessage(session: SourceSession): string {
  const candidates = session.transcript
    .filter((entry) => entry.role === "assistant")
    .map((entry) => cleanLongText(entry.text))
    .filter((text) => /(plan|steps|approach|implementation|todo|next|will|going to|checklist)/i.test(text));
  return candidates.at(-1) || "";
}

function cleanLongText(text: string): string {
  const clean = toHandoffSignal(text).replace(/\s+/g, " ").trim();
  return clean.length > 1200 ? `${clean.slice(0, 1200)}...` : clean;
}

function meaningfulList(values: string[], fallback: string[]): string[] {
  const clean = unique(values.filter((value) => !/None captured/i.test(value)));
  return clean.length ? clean : fallback;
}

function inferVerification(sections: HandoffSections, sourceSession: SourceSession | undefined): VerificationSummary {
  const transcriptText = sourceSession?.transcript.map((entry) => entry.text).join("\n") || "";
  const evidence = [...sections.commandsRun, ...sections.errors, transcriptText].join("\n");
  const verificationCommands = unique(
    sections.commandsRun.filter((command) => /\b(npm (run )?(test|typecheck|build)|pnpm (test|build)|yarn (test|build)|bun test|vitest|jest|tsc|pytest|cargo test|go test)\b/i.test(command))
  );
  const commands = verificationCommands.map((command) => ({
    command,
    status: inferCommandStatus(command, evidence),
    evidence: matchingEvidence(command, evidence)
  }));
  const failed = commands.some((command) => command.status === "failed") || sections.errors.some((error) => /(test|typecheck|build|lint).{0,80}(fail|error)|failed/i.test(error));
  const passed = commands.length > 0 && commands.every((command) => command.status === "passed");
  const status: VerificationStatus = failed ? "failed" : passed ? "passed" : "unknown";
  const gaps =
    commands.length === 0
      ? ["No verification command was captured in the source session."]
      : status === "unknown"
        ? ["Verification commands were captured, but their result was not explicit."]
        : [];
  return { status, commands, gaps };
}

function inferCommandStatus(command: string, evidence: string): VerificationStatus {
  const commandName = command.replace(/\s+/g, " ").slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nearCommand = new RegExp(`${commandName}[\\s\\S]{0,500}`, "i").exec(evidence)?.[0] || evidence;
  if (/(failed|failure|error|exception|exit code [1-9]|Process exited with code [1-9])/i.test(nearCommand)) return "failed";
  if (/(passed|success|succeeded|0 failed|Process exited with code 0|✓|✔)/i.test(nearCommand)) return "passed";
  return "unknown";
}

function matchingEvidence(command: string, evidence: string): string | undefined {
  const commandWords = command.split(/\s+/).filter((word) => word.length > 2).slice(0, 3);
  const line = evidence.split("\n").find((candidate) => commandWords.some((word) => candidate.includes(word)));
  return line ? cleanLongText(line).slice(0, 240) : undefined;
}

function inferWorkPhase(sections: HandoffSections, verification: VerificationSummary, agentPlan: string, fileChanges: FileChange[]): WorkPhase {
  if (sections.blockers.length > 0) return "blocked";
  if (verification.status === "failed" || sections.errors.length > 0) return "debugging";
  if (verification.commands.length > 0) return "verification";
  if (sections.todos.length > 0 || fileChanges.length > 0) return "implementation";
  if (agentPlan) return "planning";
  return "handoff";
}

function summarizeRepoStats(fileChanges: FileChange[]) {
  return fileChanges.reduce(
    (stats, file) => ({
      dirtyFiles: stats.dirtyFiles + 1,
      stagedFiles: stats.stagedFiles + (file.staged ? 1 : 0),
      unstagedFiles: stats.unstagedFiles + (file.unstaged ? 1 : 0),
      untrackedFiles: stats.untrackedFiles + (file.untracked ? 1 : 0),
      additions: stats.additions + (file.additions || 0),
      deletions: stats.deletions + (file.deletions || 0)
    }),
    { dirtyFiles: 0, stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, additions: 0, deletions: 0 }
  );
}

function buildContextSignals(sections: HandoffSections, latestUserInstruction: string, latestAssistantSummary: string): ContextSignal[] {
  const signals: ContextSignal[] = [];
  for (const text of limit(sections.decisions, 4)) signals.push({ kind: "decision", text });
  for (const text of limit(sections.doNotRepeat, 3)) signals.push({ kind: "constraint", text });
  for (const text of limit([...sections.blockers, ...sections.errors], 4)) signals.push({ kind: "risk", text });
  if (latestUserInstruction) signals.push({ kind: "anchor", text: `Latest user instruction: ${latestUserInstruction}` });
  if (latestAssistantSummary) signals.push({ kind: "anchor", text: `Latest assistant summary: ${latestAssistantSummary}` });
  return signals.slice(0, 10);
}

export function buildEngineeringMemory(
  task: string,
  repo: GitSnapshot,
  sourceSession: SourceSession | undefined,
  handoffId: string,
  summary: HandoffContinuitySummary
): EngineeringMemory {
  const sourceLabel = sourceSession ? `${sourceSession.source}:${sourceSession.id}` : "local-capture";
  return {
    version: 1,
    identity: {
      taskId: stableId("task", `${repo.repoPath}:${task}`),
      repoId: stableId("repo", repo.repoPath),
      branchId: stableId("branch", `${repo.repoPath}:${repo.branch}`),
      commitId: stableId("commit", `${repo.repoPath}:${repo.commit}`),
      handoffId,
      sessionId: sourceSession?.id,
      sourceAgent: sourceSession?.source
    },
    positioning: {
      category: "handoff-ledger",
      buyer: "ai-heavy-engineering-teams",
      moat: "provenance-backed-engineering-memory"
    },
    intent: facts("intent", [summary.originalQuestion, summary.latestUserInstruction], "user-authored", "high", sourceLabel),
    decisions: facts("decision", summary.decisions, "transcript-derived", "medium", sourceLabel),
    constraints: facts("constraint", summary.contextSignals.filter((signal) => signal.kind === "constraint").map((signal) => signal.text), "transcript-derived", "medium", sourceLabel),
    verification: facts(
      "verification",
      summary.verification.commands.length
        ? summary.verification.commands.map((command) => `${command.status}: ${command.command}`)
        : summary.verification.gaps,
      "command-derived",
      summary.verification.commands.length ? "high" : "low",
      sourceLabel
    ),
    risks: facts("risk", [...summary.blockers, ...summary.errors], "transcript-derived", "medium", sourceLabel),
    nextActions: facts("next-action", [summary.nextAction, ...summary.remainingWork], "ai-inferred", "medium", sourceLabel),
    changedFiles: facts("changed-file", formatFileChanges(summary.fileChanges), "diff-derived", "high", repo.repoPath),
    teamSync: {
      mode: "local-only",
      rawTranscript: "included",
      filePreviewRedaction: "enabled",
      secretsRedaction: "enabled",
      userControlledSync: true
    }
  };
}

function facts(
  category: string,
  values: string[],
  provenanceKind: ProvenanceKind,
  confidence: "high" | "medium" | "low",
  source: string
): MemoryFact[] {
  return unique(values)
    .filter((value) => !/^None captured\.?$/i.test(value))
    .slice(0, 12)
    .map((text) => ({
      id: stableId(category, text),
      text,
      provenance: {
        kind: provenanceKind,
        confidence,
        source
      }
    }));
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${hashText(seed || prefix)}`;
}

function renderEngineeringMemory(memory: EngineeringMemory): string {
  return [
    `- Category: ${memory.positioning.category}`,
    `- Buyer: ${memory.positioning.buyer}`,
    `- Moat: ${memory.positioning.moat}`,
    `- IDs: task=${memory.identity.taskId}, repo=${memory.identity.repoId}, branch=${memory.identity.branchId}, commit=${memory.identity.commitId}, handoff=${memory.identity.handoffId}`,
    `- Team sync: ${memory.teamSync.mode}, transcript ${memory.teamSync.rawTranscript}, redaction ${memory.teamSync.secretsRedaction}`,
    ...memory.decisions.slice(0, 4).map(renderMemoryFact),
    ...memory.verification.slice(0, 4).map(renderMemoryFact),
    ...memory.risks.slice(0, 4).map(renderMemoryFact),
    ...memory.nextActions.slice(0, 4).map(renderMemoryFact)
  ].join("\n");
}

function renderMemoryFact(fact: MemoryFact): string {
  return `- ${fact.text} [${fact.provenance.kind}, ${fact.provenance.confidence}]`;
}

function renderCurrentState(summary: HandoffContinuitySummary): string {
  return [
    `- Phase: ${summary.workPhase}`,
    `- Repo state: ${summary.repoStats.dirtyFiles} dirty, ${summary.repoStats.stagedFiles} staged, ${summary.repoStats.unstagedFiles} unstaged, ${summary.repoStats.untrackedFiles} untracked`,
    `- Diff volume: +${summary.repoStats.additions} -${summary.repoStats.deletions}`,
    `- Verification: ${summary.verification.status}`
  ].join("\n");
}

function renderVerification(verification: VerificationSummary): string {
  const lines = [`- Status: ${verification.status}`];
  for (const command of verification.commands) {
    lines.push(`- ${command.status}: ${command.command}`);
  }
  for (const gap of verification.gaps) lines.push(`- Gap: ${gap}`);
  return lines.join("\n");
}

function legacyFileChanges(files: string[]): FileChange[] {
  return unique(files).map((path) => ({
    path,
    status: "modified",
    additions: 0,
    deletions: 0,
    staged: false,
    unstaged: true,
    untracked: false
  }));
}

function formatFileChanges(changes: FileChange[]): string[] {
  return changes.map((change) => {
    const stat = change.additions || change.deletions ? ` (+${change.additions} -${change.deletions})` : "";
    const oldPath = change.oldPath ? `${change.oldPath} -> ` : "";
    return `${statusLabel(change)} ${oldPath}${change.path}${stat}`;
  });
}

function statusLabel(change: FileChange): string {
  if (change.untracked) return "??";
  if (change.status === "added") return "A";
  if (change.status === "deleted") return "D";
  if (change.status === "renamed") return "R";
  if (change.status === "copied") return "C";
  if (change.status === "modified") return "M";
  return "?";
}

function dedupeBlocks(blocks: ContextBlock[]): ContextBlock[] {
  const seen = new Set<string>();
  const result: ContextBlock[] = [];
  for (const block of blocks) {
    const key = `${block.category}:${block.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(block);
  }
  return result;
}

function sanitizeBlockForPack(block: ContextBlock, includeRawTranscript: boolean): ContextBlock {
  const text = includeRawTranscript || block.category !== "transcript" ? block.text : redactSensitiveText(block.text);
  return {
    ...block,
    text,
    estimatedChars: text.length
  };
}

function cleanContextText(text: string): string {
  return redactSensitiveText(toHandoffSignal(text).replace(/\s+/g, " ").trim()).slice(0, 2000);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|DSN)[A-Z0-9_]*\s*=\s*[^\s,;]+/gi, (match) => {
      const [key] = match.split("=");
      return `${key.trim()}=[redacted]`;
    })
    .replace(/\b(?:sk|pk|rk|ghp|gho|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "[redacted-secret]");
}

function buildPackWarnings(pack: ContextPack): string[] {
  const warnings: string[] = [];
  if (!pack.includeRawTranscript && pack.items.some((item) => item.block.category === "transcript")) {
    warnings.push("Raw transcript blocks were redacted by default. Enable raw transcript only when the destination is trusted.");
  }
  if (pack.items.some((item) => /\[redacted/.test(item.block.text))) {
    warnings.push("Potential secrets were redacted from one or more context blocks.");
  }
  if (!pack.items.some((item) => item.enabled)) warnings.push("No enabled context blocks are present in this pack.");
  return warnings;
}

function renderContextPackMarkdown(pack: ContextPack, items: ContextPackItem[], estimatedChars: number, warnings: string[]): string {
  const sections = new Map<ContextBlock["category"], ContextPackItem[]>();
  for (const item of items) {
    const current = sections.get(item.block.category) || [];
    current.push(item);
    sections.set(item.block.category, current);
  }
  const lines = [
    `# Context Pack: ${pack.name}`,
    "",
    `Pack ID: ${pack.id}`,
    `Updated: ${pack.updatedAt}`,
    `Estimated characters: ${estimatedChars}`,
    `Raw transcript: ${pack.includeRawTranscript ? "included" : "excluded/redacted"}`,
    "",
    "## Use This Context",
    "Reuse the selected context below without re-discovering prior decisions, verification, changed files, or next actions.",
    ""
  ];
  if (warnings.length) {
    lines.push("## Warnings", ...warnings.map((warning) => `- ${warning}`), "");
  }
  for (const [category, categoryItems] of sections) {
    lines.push(`## ${contextCategoryTitle(category)}`);
    for (const item of categoryItems) {
      lines.push(`- ${item.block.text}`);
      lines.push(`  - Source: ${item.block.sourceTask} / ${item.block.sourceHandoffId}`);
      lines.push(`  - Provenance: ${item.block.provenance.kind}, ${item.block.provenance.confidence}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function contextCategoryTitle(category: ContextBlock["category"]): string {
  switch (category) {
    case "next-action":
      return "Next Actions";
    case "changed-file":
      return "Changed Files";
    default:
      return labelize(category);
  }
}

function labelize(value: string): string {
  return value.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toHandoffSignal(text: string): string {
  if (
    /(<permissions instructions>|<collaboration_mode>|<skills_instructions>|<plugins_instructions>|<environment_context>|<image>)/i.test(text) ||
    /Knowledge cutoff:|You are Codex|Filesystem sandboxing defines|Available skills|Skill roots|Tool definitions|Valid channels:|# Handoff:/i.test(text)
  ) {
    return "";
  }
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

function segmentText(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 8)
    .map((part) => (part.length > 800 ? `${part.slice(0, 800)}...` : part));
}

function extractFilePaths(snippets: string[]): string[] {
  const matches: string[] = [];
  const pattern = /\b(?:\.{0,2}\/)?(?:src|apps|app|packages|lib|server|client|tests?|docs)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}\b|\b[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|sql|sh|py|go|rs)\b/g;
  for (const snippet of snippets) {
    const found = snippet.match(pattern);
    if (!found) continue;
    for (const file of found) {
      matches.push(file.replace(/[),.;:!?]+$/g, ""));
    }
  }
  return unique(matches);
}

async function improveWithOllama(task: string, sections: HandoffSections): Promise<string | undefined> {
  const model = process.env.CTXPOOL_OLLAMA_MODEL || "llama3.1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        prompt: [
          "Write one concise next best action for a coding-agent handoff.",
          `Task: ${task}`,
          `Todos: ${sections.todos.join("; ")}`,
          `Blockers: ${sections.blockers.join("; ")}`,
          `Files: ${sections.filesTouched.join("; ")}`
        ].join("\n")
      })
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { response?: string };
    return json.response?.trim().split("\n")[0]?.slice(0, 500);
  } finally {
    clearTimeout(timeout);
  }
}
