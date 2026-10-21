import { mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentSignal,
  CommandRun,
  ContextBlock,
  ContextSignal,
  EngineeringMemory,
  FileChange,
  GitSnapshot,
  HandoffContinuitySummary,
  HandoffListItem,
  HandoffPacket,
  HandoffSections,
  MemoryFact,
  PlanItem,
  ProvenanceKind,
  SourceSession,
  VerificationCommand,
  VerificationSummary,
  WorkPhase
} from "./types.js";
import { ensureCtxDirs } from "./paths.js";
import { redactDeep, redactSecrets } from "./redact.js";
import { captureGitSnapshot, inferTaskName } from "./repo.js";
import { cleanTranscriptEntries, resolveSessionSource, sourceLabel, type SessionFrom } from "./session.js";
import { estimateTokens, oneLine, truncate } from "./text.js";
import { canonicalPath, hashText, limit, slugify, unique } from "./util.js";
import { isVerificationCommand, verificationKey, verificationLabel } from "./verify.js";
import { VERSION } from "./version.js";

export { createContextPack, normalizeContextPack, renderContextPackOutput } from "./pack.js";

export type CreateHandoffOptions = {
  cwd?: string;
  task?: string;
  to?: string;
  from?: SessionFrom;
  session?: string;
  includeTranscript?: boolean;
  /** Token budget for the transcript excerpt. */
  budget?: number;
  useOllama?: boolean;
  ollamaModel?: string;
};

// Agents narrate obstacles they then work around; only their latest messages describe the current state.
const BLOCKER_WINDOW = 2;
const TODO_WINDOW = 4;

export async function createHandoff(options: CreateHandoffOptions = {}): Promise<HandoffPacket> {
  const cwd = resolve(options.cwd || process.cwd());
  const paths = ensureCtxDirs();
  const repo = captureGitSnapshot(cwd);
  const task = inferTaskName(options.task, repo);
  const sourceSession = withRepoRelativeEdits(
    redactDeep(
      resolveSessionSource({
        from: options.from || "auto",
        cwd,
        repoRoot: repo.isGitRepo ? repo.repoPath : undefined,
        session: options.session,
        budget: options.budget
      })
    ),
    repo.repoPath
  );
  const sections = buildSections(task, repo.dirtyFiles, repo.diffStat, sourceSession);
  const handoffSummary = buildHandoffSummary(task, repo, sourceSession, sections);
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${hashText(`${task}:${createdAt}`)}`;

  if (options.useOllama) {
    const improved = await suggestNextActionWithOllama(task, handoffSummary, options.ollamaModel).catch(() => undefined);
    if (improved) {
      sections.nextBestAction = improved;
      handoffSummary.nextAction = improved;
    }
  }

  const packet: HandoffPacket = {
    id,
    task,
    createdAt,
    targetAgent: options.to,
    repo,
    sources: [{ source: sourceSession.source, path: sourceSession.path, modifiedAt: sourceSession.updatedAt, snippets: [] }],
    sourceSession,
    sections,
    handoffSummary,
    engineeringMemory: buildEngineeringMemory(task, repo, sourceSession, id, handoffSummary),
    markdown: "",
    markdownPath: ""
  };
  packet.markdown = renderHandoffMarkdown(packet, options.includeTranscript !== false);
  packet.tokenEstimate = estimateTokens(packet.markdown);

  const taskDir = join(paths.handoffsDir, slugify(task));
  mkdirSync(taskDir, { recursive: true });
  packet.markdownPath = join(taskDir, `${createdAt.replace(/[:.]/g, "-")}.md`);
  writeFileSync(packet.markdownPath, packet.markdown, { encoding: "utf8", mode: 0o600 });
  return packet;
}

// ---------------------------------------------------------------------------
// Extraction

/**
 * Pull the working state out of a session. Structured agent data (plans, command exit codes, edits)
 * wins; prose heuristics fill gaps and only read the user's and the agent's own words, never tool output.
 */
export function buildSections(task: string, filesTouched: string[], diffStat: string, sourceSessionOrSources: SourceSession | AgentSignal[]): HandoffSections {
  const session = Array.isArray(sourceSessionOrSources) ? undefined : sourceSessionOrSources;
  const legacySnippets = Array.isArray(sourceSessionOrSources) ? sourceSessionOrSources.flatMap((source) => source.snippets) : [];

  const userMessages = session ? session.transcript.filter((entry) => entry.role === "user").map((entry) => entry.text) : [];
  const assistantMessages = session ? session.transcript.filter((entry) => entry.role === "assistant").map((entry) => entry.text) : [];
  const allProse = session ? assistantMessages.flatMap(sentences) : legacySnippets.flatMap(sentences);
  const recent = (count: number) => (session ? assistantMessages.slice(-count).flatMap(sentences) : allProse);

  const plan = session?.plan;
  const completed = plan ? plan.filter((item) => item.status === "completed").map((item) => item.text) : pick(allProse, COMPLETED, 8);
  const inProgress = plan ? plan.filter((item) => item.status === "in_progress").map((item) => item.text) : [];
  const todos = plan ? plan.filter((item) => item.status !== "completed").map((item) => item.text) : pick(recent(TODO_WINDOW), TODO, 10);
  const blockers = pick(recent(BLOCKER_WINDOW), BLOCKER, 6);
  const verification = summarizeVerification(session, legacySnippets);
  const errors = session
    ? verification.commands.filter((command) => command.status === "failed").map((command) => `\`${command.command}\` failed${command.evidence ? `: ${command.evidence}` : ""}`)
    : pick(legacySnippets, /\b(error|failed|failure|exception|traceback)\b/i, 8);
  const commandsRun = session ? limit((session.commands || []).map((run) => run.command), 20) : pick(legacySnippets, SHELL_TOOL, 12);
  const editedFiles = (session?.edits || []).map((edit) => edit.path);
  const mentionedFiles = session ? [] : extractFilePaths(legacySnippets);
  const decisions = pick(allProse, DECISION, 8);
  // The first and latest requests are rendered in full, so constraints come from the messages in between.
  const constraints = limit([...userMessages.slice(1, -1).flatMap(sentences).filter((sentence) => CONSTRAINT.test(sentence)), ...pick(allProse, DEAD_END, 4)], 8);
  const changedFiles = limit([...filesTouched, ...editedFiles, ...mentionedFiles], 40);

  return {
    goal: `Continue the ${task} task.`,
    currentStatus: [
      changedFiles.length ? `${changedFiles.length} changed file(s)${diffStat ? ` (${diffStat})` : ""}.` : "Working tree is clean.",
      `Verification: ${verification.status}.`
    ],
    completed,
    inProgress,
    todos,
    blockers,
    filesTouched: changedFiles,
    commandsRun,
    errors,
    decisions,
    doNotRepeat: constraints,
    nextBestAction: chooseNextAction({
      verification,
      blockers,
      plan,
      todos,
      changedFileCount: changedFiles.length,
      latestUserMessage: userMessages.at(-1)
    })
  };
}

export function buildHandoffSummary(task: string, repo: GitSnapshot, sourceSession: SourceSession | undefined, sections: HandoffSections): HandoffContinuitySummary {
  const fileChanges = repo.fileChanges?.length ? repo.fileChanges : legacyFileChanges(repo.dirtyFiles || []);
  const userMessages = sourceSession?.transcript.filter((entry) => entry.role === "user").map((entry) => entry.text) || [];
  const assistantMessages = sourceSession?.transcript.filter((entry) => entry.role === "assistant").map((entry) => entry.text) || [];
  const verification = summarizeVerification(sourceSession, sections.commandsRun);
  const plan = sourceSession?.plan;
  const agentPlan = sourceSession?.planText || (plan ? plan.map(formatPlanItem).join("\n") : latestPlanMessage(assistantMessages));
  const originalQuestion = truncate(userMessages[0] || "", 1_500);
  const latestUserInstruction = truncate(userMessages.at(-1) || "", 1_500);
  const latestAssistantSummary = truncate(assistantMessages.at(-1) || "", 1_500);

  return {
    version: 1,
    title: sourceSession?.threadName,
    originalQuestion: originalQuestion || `Continue the ${task} task.`,
    latestUserInstruction: latestUserInstruction || originalQuestion || `Continue the ${task} task.`,
    latestAssistantSummary,
    agentPlan,
    workPhase: inferWorkPhase(sections, verification, plan, agentPlan, fileChanges),
    verification,
    repoStats: summarizeRepoStats(fileChanges),
    contextSignals: buildContextSignals(sections, latestUserInstruction || originalQuestion, latestAssistantSummary),
    completedWork: sections.completed,
    inProgressWork: sections.inProgress,
    remainingWork: sections.todos,
    blockers: sections.blockers,
    nextAction: sections.nextBestAction,
    fileChanges,
    commandsRun: sections.commandsRun,
    errors: sections.errors,
    decisions: sections.decisions,
    constraints: sections.doNotRepeat,
    plan,
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

const COMPLETED = /^(?:done|completed|fixed|implemented|added|created|updated|refactored|removed|shipped|wrote)\b|\b(?:i(?:'ve| have)|we(?:'ve| have)|now)\s+(?:added|fixed|implemented|updated|created|removed|refactored|wired)\b/i;
const TODO = /\b(?:todo|still need(?:s)? to|left to do|not yet (?:done|implemented|handled)|remaining(?: work)?:|follow[- ]?up:|next step)/i;
const BLOCKER =
  /\b(?:blocked|blocker|stuck|cannot proceed|can't proceed|unable to (?:proceed|continue)|waiting (?:on|for) (?:you|the user|approval|access)|need(?:s)? (?:your|user) (?:input|approval|confirmation)|permission denied|is missing|not configured|missing (?:credentials|access|env))\b/i;
const DECISION = /^(?:decision|decided)\b|\b(?:decided to|chose to|opted to|going with|we(?:'ll| will) use|i(?:'ll| will) use|instead of)\b/i;
const CONSTRAINT = /\b(?:don't|do not|never|always|must(?! have)|should not|shouldn't|avoid|make sure|only use|without)\b/i;
const DEAD_END = /\b(?:already tried|didn't work|doesn't work|did not work|reverted|rolled back)\b/i;
const SHELL_TOOL = /\b(npm|pnpm|yarn|bun|git|node|tsx|tsc|vitest|pytest|cargo|go test)\b/i;

function pick(snippets: string[], pattern: RegExp, count: number): string[] {
  return limit(snippets.filter((snippet) => pattern.test(snippet)).reverse().map((snippet) => truncate(snippet, 300)), count);
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9`*])/)
    .map((part) => part.replace(/^[-*>\d.)\s]+/, "").replace(/\*\*/g, "").trim())
    .filter((part) => part.length > 8 && part.length < 600 && !/^```/.test(part));
}

function chooseNextAction(input: {
  verification: VerificationSummary;
  blockers: string[];
  plan?: PlanItem[];
  todos: string[];
  changedFileCount: number;
  latestUserMessage?: string;
}): string {
  const failed = input.verification.commands.find((command) => command.status === "failed");
  if (failed) return `Fix the failing \`${failed.command}\`${failed.evidence ? ` (${failed.evidence})` : ""}, then re-run it.`;
  if (input.blockers[0]) return `Resolve the blocker: ${input.blockers[0]}`;

  const active = input.plan?.find((item) => item.status === "in_progress");
  if (active) return `Continue: ${active.text}`;
  const pending = input.plan?.find((item) => item.status === "pending");
  if (pending) return `Next: ${pending.text}`;

  const unverified = input.verification.gaps.some((gap) => /edited after|No tests/.test(gap));
  if (input.changedFileCount && unverified) {
    const checks = unique(input.verification.commands.map((command) => `\`${command.command}\``)).slice(-2);
    return `Verify the ${input.changedFileCount} changed file(s) with ${checks.length ? checks.join(" and ") : "the project's tests and type checks"}.`;
  }
  if (input.todos[0]) return input.todos[0];
  if (input.latestUserMessage) return `Confirm the latest request is fully handled: “${truncate(oneLine(input.latestUserMessage), 160)}”`;
  return "Review the current diff and continue the task.";
}

function summarizeVerification(session: SourceSession | undefined, legacyEvidence: string[]): VerificationSummary {
  const runs = (session?.commands || []).filter((run) => isVerificationCommand(run.command));
  if (!session?.commands) return legacyVerification(legacyEvidence);

  const latest = new Map<string, CommandRun>();
  for (const run of runs) latest.set(verificationKey(run.command), run);
  const latestRuns = [...latest.values()].sort((a, b) => a.seq - b.seq);
  const commands: VerificationCommand[] = latestRuns.map((run) => ({
    command: truncate(verificationLabel(run.command), 160),
    status: run.status,
    exitCode: run.exitCode,
    evidence: run.errorLine
  }));

  const failed = commands.some((command) => command.status === "failed");
  const passed = commands.length > 0 && commands.every((command) => command.status === "passed");
  const lastEdit = Math.max(-1, ...(session.edits || []).map((edit) => edit.seq));
  const lastPass = Math.max(-1, ...latestRuns.filter((run) => run.status === "passed").map((run) => run.seq));
  const stale = passed && lastEdit > lastPass;

  const gaps: string[] = [];
  if (!commands.length) gaps.push("No tests, type checks, or builds were run in the session.");
  else if (!failed && !passed) gaps.push("Some checks ran without a recorded result.");
  if (stale) gaps.push("Files were edited after the last passing check.");

  return { status: failed ? "failed" : passed && !stale ? "passed" : "unknown", commands, gaps };
}

/** Packets and inputs without structured command data: look for verification commands in text. */
function legacyVerification(evidence: string[]): VerificationSummary {
  const commands = unique(evidence.filter(isVerificationCommand)).map((command) => ({
    command,
    status: /\b(failed|failure|error)\b/i.test(command) ? ("failed" as const) : /\b(passed|succeeded)\b/i.test(command) ? ("passed" as const) : ("unknown" as const)
  }));
  const failed = commands.some((command) => command.status === "failed");
  const passed = commands.length > 0 && commands.every((command) => command.status === "passed");
  return {
    status: failed ? "failed" : passed ? "passed" : "unknown",
    commands,
    gaps: commands.length ? (failed || passed ? [] : ["Some checks ran without a recorded result."]) : ["No tests, type checks, or builds were run in the session."]
  };
}

function inferWorkPhase(sections: HandoffSections, verification: VerificationSummary, plan: PlanItem[] | undefined, agentPlan: string, fileChanges: FileChange[]): WorkPhase {
  if (sections.blockers.length) return "blocked";
  if (verification.status === "failed") return "debugging";
  if (plan?.some((item) => item.status !== "completed")) return plan.some((item) => item.status !== "pending") || fileChanges.length ? "implementation" : "planning";
  if (verification.status === "passed") return "review";
  if (verification.commands.length) return "verification";
  if (sections.todos.length || fileChanges.length) return "implementation";
  if (agentPlan) return "planning";
  return "handoff";
}

function latestPlanMessage(assistantMessages: string[]): string {
  const plan = [...assistantMessages].reverse().find((text) => /^(?:plan|here'?s (?:the|my) plan|steps?|approach)\b\s*:?/im.test(text));
  return plan ? truncate(plan, 1_500) : "";
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
  for (const text of limit(sections.doNotRepeat, 4)) signals.push({ kind: "constraint", text });
  for (const text of limit([...sections.blockers, ...sections.errors], 4)) signals.push({ kind: "risk", text });
  if (latestUserInstruction) signals.push({ kind: "anchor", text: `Latest user instruction: ${truncate(latestUserInstruction, 300)}` });
  if (latestAssistantSummary) signals.push({ kind: "anchor", text: `Latest agent update: ${truncate(latestAssistantSummary, 300)}` });
  return signals.slice(0, 12);
}

function extractFilePaths(snippets: string[]): string[] {
  const pattern = /(?:^|[\s`'"(])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|ya?ml|toml|sql|sh|py|go|rs|rb|java|kt|swift|css|html))(?=$|[\s`'"),.;:!?])/g;
  return unique(snippets.flatMap((snippet) => Array.from(snippet.matchAll(pattern), (match) => match[1])));
}

function withRepoRelativeEdits(session: SourceSession, repoPath: string): SourceSession {
  const root = canonicalPath(repoPath);
  const edits = (session.edits || []).map((edit) => {
    if (!isAbsolute(edit.path)) return edit;
    const rel = relative(root, canonicalPath(edit.path));
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? { ...edit, path: rel } : edit;
  });
  return { ...session, edits };
}

// ---------------------------------------------------------------------------
// Normalization (packets saved by older versions)

export function normalizeHandoffPacket(input: HandoffPacket): HandoffPacket {
  const packet = input.handoffSummary ? input : cleanLegacyPacket(input);
  const repo = {
    ...packet.repo,
    fileChanges: packet.repo.fileChanges?.length ? packet.repo.fileChanges : legacyFileChanges(packet.repo.dirtyFiles || [])
  };
  const derived = buildHandoffSummary(packet.task, repo, packet.sourceSession, packet.sections);
  const existing = packet.handoffSummary;
  const handoffSummary: HandoffContinuitySummary = existing
    ? {
        ...derived,
        ...existing,
        fileChanges: existing.fileChanges?.length ? existing.fileChanges : derived.fileChanges,
        verification: existing.verification || derived.verification,
        repoStats: existing.repoStats || derived.repoStats,
        contextSignals: existing.contextSignals?.length ? existing.contextSignals : derived.contextSignals,
        sourceSession: existing.sourceSession || derived.sourceSession,
        repo: existing.repo || derived.repo
      }
    : derived;
  const engineeringMemory = packet.engineeringMemory || buildEngineeringMemory(packet.task, repo, packet.sourceSession, packet.id, handoffSummary);
  return { ...packet, repo, handoffSummary, engineeringMemory };
}

/** Packets saved before v0.2 kept injected harness text as user messages; re-read them without it. */
function cleanLegacyPacket(packet: HandoffPacket): HandoffPacket {
  if (!packet.sourceSession) return packet;
  const sourceSession = { ...packet.sourceSession, transcript: cleanTranscriptEntries(packet.sourceSession.transcript) };
  const sections = buildSections(packet.task, packet.repo.dirtyFiles || [], packet.repo.diffStat || "", sourceSession);
  return { ...packet, sourceSession, sections };
}

/** The compact shape the web UI lists and charts. */
export function summarizeHandoff(packet: HandoffPacket): HandoffListItem {
  const normalized = normalizeHandoffPacket(packet);
  const summary = normalized.handoffSummary!;
  const commands = summary.verification.commands;
  const plan = summary.plan || [];
  const changes = summary.fileChanges;
  return {
    id: normalized.id,
    task: normalized.task,
    createdAt: normalized.createdAt,
    title: summary.title,
    source: summary.sourceSession?.source,
    sessionId: summary.sourceSession?.id,
    targetAgent: normalized.targetAgent,
    repoPath: normalized.repo.repoPath,
    repoName: basename(normalized.repo.repoPath),
    branch: normalized.repo.branch,
    commit: normalized.repo.commit,
    isGitRepo: normalized.repo.isGitRepo,
    phase: summary.workPhase,
    objective: truncate(oneLine(summary.originalQuestion), 280),
    nextAction: truncate(oneLine(summary.nextAction), 280),
    verification: summary.verification.status,
    checks: {
      passed: commands.filter((command) => command.status === "passed").length,
      failed: commands.filter((command) => command.status === "failed").length,
      unknown: commands.filter((command) => command.status === "unknown").length
    },
    plan: {
      total: plan.length,
      completed: plan.filter((item) => item.status === "completed").length,
      inProgress: plan.filter((item) => item.status === "in_progress").length
    },
    files: {
      count: changes.length,
      additions: changes.reduce((sum, change) => sum + change.additions, 0),
      deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
      paths: changes.slice(0, 50).map((change) => change.path)
    },
    blockers: summary.blockers.length,
    tokens: normalized.tokenEstimate ?? estimateTokens(normalized.markdown),
    transcriptItems: summary.sourceSession?.transcriptItems ?? 0
  };
}

export function buildEngineeringMemory(
  task: string,
  repo: GitSnapshot,
  sourceSession: SourceSession | undefined,
  handoffId: string,
  summary: HandoffContinuitySummary
): EngineeringMemory {
  const sourceLabel = sourceSession ? `${sourceSession.source}:${sourceSession.id}` : "local-capture";
  const verified = summary.verification.commands.length > 0;
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
    intent: facts("intent", [summary.originalQuestion, summary.latestUserInstruction], "user-authored", "high", sourceLabel),
    decisions: facts("decision", summary.decisions, "transcript-derived", "medium", sourceLabel),
    constraints: facts("constraint", summary.constraints || [], "user-authored", "medium", sourceLabel),
    verification: facts(
      "verification",
      verified ? summary.verification.commands.map((command) => `${command.status}: ${command.command}`) : summary.verification.gaps,
      "command-derived",
      verified ? "high" : "low",
      sourceLabel
    ),
    risks: facts("risk", [...summary.blockers, ...summary.errors], "transcript-derived", "medium", sourceLabel),
    nextActions: facts("next-action", [summary.nextAction, ...summary.remainingWork], summary.plan ? "transcript-derived" : "ai-inferred", "medium", sourceLabel),
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

function facts(category: string, values: string[], provenanceKind: ProvenanceKind, confidence: "high" | "medium" | "low", source: string): MemoryFact[] {
  return unique(values)
    .slice(0, 12)
    .map((text) => ({ id: stableId(category, text), text, provenance: { kind: provenanceKind, confidence, source } }));
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${hashText(seed || prefix)}`;
}

// ---------------------------------------------------------------------------
// Rendering

/**
 * The handoff an agent reads. Ordered by what the next agent needs first; empty sections are omitted.
 */
export function renderHandoffMarkdown(packet: HandoffPacket, includeTranscript = true): string {
  const normalized = normalizeHandoffPacket(packet);
  const summary = normalized.handoffSummary!;
  const session = normalized.sourceSession;
  const stats = summary.repoStats;
  const meta = [
    basename(normalized.repo.repoPath),
    normalized.repo.isGitRepo ? `${normalized.repo.branch} @ ${normalized.repo.commit}` : "not a git repo",
    stats.dirtyFiles ? `${stats.dirtyFiles} changed ${stats.dirtyFiles === 1 ? "file" : "files"} (+${stats.additions} -${stats.deletions})` : "clean tree",
    session ? `${sourceLabel(session.source)} session` : undefined,
    normalized.createdAt.slice(0, 16).replace("T", " ")
  ].filter(Boolean);

  const lines: string[] = [
    `# Handoff: ${normalized.task}`,
    "",
    `> ${meta.join(" · ")}`,
    "",
    `${normalized.targetAgent ? `For ${normalized.targetAgent}: c` : "C"}ontinue this task. Check that the repo matches the state below, then start from **Next action**.`
  ];

  const section = (title: string, body: string | string[] | undefined) => {
    const content = Array.isArray(body) ? body.filter(Boolean).join("\n") : body?.trim();
    if (content) lines.push("", `## ${title}`, content);
  };

  const objective = summary.originalQuestion;
  section("Objective", objective);
  if (summary.latestUserInstruction && summary.latestUserInstruction !== objective) section("Latest request", summary.latestUserInstruction);
  section("Next action", summary.nextAction);
  section("Status", [
    `- Phase: ${summary.workPhase}`,
    `- Verification: ${summary.verification.status}`,
    summary.latestAssistantSummary ? `- Last update from the agent: ${truncate(oneLine(summary.latestAssistantSummary), 600)}` : ""
  ]);
  section("Plan", summary.plan?.length ? summary.plan.map(formatPlanItem) : summary.agentPlan && !summary.plan ? truncate(summary.agentPlan, 1_500) : undefined);
  section("Verification", renderVerification(summary.verification));
  section("Changed files", renderFileChanges(summary.fileChanges));
  section("Decisions", bullets(summary.decisions, 6));
  section("Constraints", bullets(summary.constraints || normalized.sections.doNotRepeat, 6));
  section("Blockers", bullets(summary.blockers, 6));
  if (!summary.verification.commands.length) section("Errors", bullets(summary.errors, 6));
  section("Earlier context", session?.compactSummary ? truncate(session.compactSummary, 2_000) : undefined);
  section("Links", bullets(session?.links || [], 5));
  if (includeTranscript) section("Recent transcript", session?.transcriptExcerpt);

  lines.push(
    "",
    "---",
    `Source: ${session ? `${sourceLabel(session.source)} session ${session.id}${session.threadName ? ` (“${session.threadName}”)` : ""}` : "local capture"}`,
    `Repo: ${normalized.repo.repoPath}`,
    `Generated by ContextPool ${VERSION} at ${normalized.createdAt}`
  );
  return lines.join("\n");
}

/** Import-ready context for an agent: the handoff without the transcript, plus the structured summary. */
export function buildAgentContext(packet: HandoffPacket): { markdown: string; summary: HandoffContinuitySummary; engineeringMemory: EngineeringMemory } {
  const normalized = normalizeHandoffPacket(packet);
  return {
    markdown: renderHandoffMarkdown(normalized, false),
    summary: normalized.handoffSummary!,
    engineeringMemory: normalized.engineeringMemory!
  };
}

export function renderAgentContextMarkdown(packet: HandoffPacket): string {
  return renderHandoffMarkdown(packet, false);
}

function renderVerification(verification: VerificationSummary): string[] {
  const glyph = { passed: "✓", failed: "✗", unknown: "?" } as const;
  return [
    ...verification.commands.map((command) => {
      const exit = command.status === "failed" && command.exitCode ? ` (exit ${command.exitCode})` : command.status === "unknown" ? " (result not recorded)" : "";
      return `- ${glyph[command.status]} \`${command.command}\`${exit}${command.evidence ? ` — ${command.evidence}` : ""}`;
    }),
    ...verification.gaps.map((gap) => `- Gap: ${gap}`)
  ];
}

function renderFileChanges(changes: FileChange[]): string[] {
  const lines = formatFileChanges(changes.slice(0, 30)).map((line) => `- ${line}`);
  if (changes.length > 30) lines.push(`- …and ${changes.length - 30} more`);
  return lines;
}

function bullets(values: string[], max: number): string[] {
  return unique(values)
    .slice(0, max)
    .map((value) => `- ${truncate(oneLine(value), 300)}`);
}

function formatPlanItem(item: PlanItem): string {
  if (item.status === "completed") return `- [x] ${item.text}`;
  return `- [ ] ${item.text}${item.status === "in_progress" ? " (in progress)" : ""}`;
}

function legacyFileChanges(files: string[]): FileChange[] {
  return unique(files).map((path) => ({ path, status: "modified", additions: 0, deletions: 0, staged: false, unstaged: true, untracked: false }));
}

function formatFileChanges(changes: FileChange[]): string[] {
  return changes.map((change) => {
    const stat = change.additions || change.deletions ? ` (+${change.additions} -${change.deletions})` : "";
    const oldPath = change.oldPath ? `${change.oldPath} → ` : "";
    return `${statusLabel(change)} ${oldPath}${change.path}${stat}`;
  });
}

function statusLabel(change: FileChange): string {
  if (change.untracked) return "??";
  return { added: "A", deleted: "D", renamed: "R", copied: "C", modified: "M", untracked: "??", unknown: "?" }[change.status];
}

// ---------------------------------------------------------------------------
// Context blocks

export function deriveContextBlocks(packet: HandoffPacket): ContextBlock[] {
  const normalized = normalizeHandoffPacket(packet);
  const summary = normalized.handoffSummary!;
  const memory = normalized.engineeringMemory!;
  const source = `${summary.sourceSession?.source || "handoff"}:${summary.sourceSession?.id || normalized.id}`;
  const blocks: ContextBlock[] = [];
  const seen = new Set<string>();
  const push = (category: ContextBlock["category"], title: string, text: string, provenance: ProvenanceKind, confidence: "high" | "medium" | "low", provenanceSource = source) => {
    const clean = redactSecrets(oneLine(text)).slice(0, 2_000);
    const key = `${category}:${clean}`;
    if (clean.length < 3 || seen.has(key)) return;
    seen.add(key);
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

  push("intent", "Objective", summary.originalQuestion, "user-authored", "high");
  if (summary.latestUserInstruction !== summary.originalQuestion) push("instruction", "Latest request", summary.latestUserInstruction, "user-authored", "high");
  push("next-action", "Next action", summary.nextAction, summary.plan ? "transcript-derived" : "ai-inferred", "medium");
  for (const fact of memory.decisions) push("decision", "Decision", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.constraints) push("constraint", "Constraint", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.verification) push("verification", "Verification", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.risks) push("risk", "Risk", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.nextActions.slice(1)) push("next-action", "Remaining work", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const fact of memory.changedFiles) push("changed-file", "Changed file", fact.text, fact.provenance.kind, fact.provenance.confidence, fact.provenance.source);
  for (const entry of normalized.sourceSession?.transcript || []) {
    if (entry.role === "tool" || entry.text.length < 20) continue;
    push("transcript", entry.role === "user" ? "User" : "Agent", entry.text, "transcript-derived", "medium");
  }
  return blocks.slice(0, 160);
}

// ---------------------------------------------------------------------------
// Team export

export function buildTeamTimelineExport(packet: HandoffPacket, options: { includeRawTranscript?: boolean } = {}): HandoffPacket {
  const normalized = normalizeHandoffPacket(packet);
  const includeRawTranscript = options.includeRawTranscript === true;
  const sourceSession = normalized.sourceSession
    ? {
        ...normalized.sourceSession,
        transcript: includeRawTranscript ? normalized.sourceSession.transcript : [],
        transcriptExcerpt: includeRawTranscript ? normalized.sourceSession.transcriptExcerpt : "",
        compactSummary: includeRawTranscript ? normalized.sourceSession.compactSummary : undefined
      }
    : undefined;
  const exportPacket: HandoffPacket = {
    ...normalized,
    sourceSession,
    sources: normalized.sources.map((source) => ({ ...source, snippets: includeRawTranscript ? source.snippets : [] })),
    engineeringMemory: {
      ...normalized.engineeringMemory!,
      teamSync: {
        mode: "sync-ready",
        rawTranscript: includeRawTranscript ? "included" : "excluded",
        filePreviewRedaction: "enabled",
        secretsRedaction: "enabled",
        userControlledSync: true
      }
    },
    markdown: ""
  };
  exportPacket.markdown = renderHandoffMarkdown(exportPacket, includeRawTranscript);
  // Packets saved by older versions were not redacted at capture; redact everything on the way out.
  return redactDeep(exportPacket);
}

// ---------------------------------------------------------------------------
// Optional local model

async function suggestNextActionWithOllama(task: string, summary: HandoffContinuitySummary, configuredModel?: string): Promise<string | undefined> {
  const host = process.env.OLLAMA_HOST ? normalizeOllamaHost(process.env.OLLAMA_HOST) : "http://127.0.0.1:11434";
  const model = configuredModel || process.env.CTXPOOL_OLLAMA_MODEL || (await firstOllamaModel(host));
  if (!model) return undefined;
  const response = await fetch(`${host}/api/generate`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: { temperature: 0.2 },
      prompt: [
        "You write the single next action for a coding agent taking over a task.",
        "Reply with one imperative sentence under 30 words. No preamble.",
        "",
        `Task: ${task}`,
        `Objective: ${truncate(summary.originalQuestion, 400)}`,
        `Latest request: ${truncate(summary.latestUserInstruction, 400)}`,
        `Remaining: ${summary.remainingWork.slice(0, 5).join("; ") || "none recorded"}`,
        `Verification: ${summary.verification.status}${summary.verification.commands.length ? ` (${summary.verification.commands.map((command) => `${command.command}: ${command.status}`).join("; ")})` : ""}`,
        `Blockers: ${summary.blockers.join("; ") || "none"}`,
        `Changed files: ${summary.fileChanges.slice(0, 10).map((change) => change.path).join(", ") || "none"}`
      ].join("\n")
    })
  });
  if (!response.ok) return undefined;
  const json = (await response.json()) as { response?: string };
  const sentence = json.response?.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n")[0]?.replace(/^["'“]|["'”]$/g, "");
  return sentence ? truncate(sentence, 400) : undefined;
}

async function firstOllamaModel(host: string): Promise<string | undefined> {
  const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1_500) });
  if (!response.ok) return undefined;
  const json = (await response.json()) as { models?: { name?: string }[] };
  return json.models?.find((model) => model.name)?.name;
}

function normalizeOllamaHost(value: string): string {
  const withScheme = /^https?:\/\//.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, "");
}
