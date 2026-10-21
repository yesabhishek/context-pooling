export type GitSnapshot = {
  repoPath: string;
  isGitRepo: boolean;
  branch: string;
  commit: string;
  dirtyFiles: string[];
  fileChanges?: FileChange[];
  diffStat: string;
  diffPatch: string;
  diffPatchTruncated: boolean;
  stagedDiffPatch?: string;
  stagedDiffPatchTruncated?: boolean;
  unstagedDiffPatch?: string;
  unstagedDiffPatchTruncated?: boolean;
  recentCommits: string[];
};

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";

export type FileChange = {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  indexStatus?: string;
  worktreeStatus?: string;
  additions: number;
  deletions: number;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  diff?: string;
};

export type WorkPhase = "planning" | "implementation" | "debugging" | "verification" | "review" | "blocked" | "handoff";

export type VerificationStatus = "passed" | "failed" | "unknown";

export type VerificationCommand = {
  command: string;
  status: VerificationStatus;
  exitCode?: number;
  evidence?: string;
};

export type PlanStatus = "pending" | "in_progress" | "completed";

export type PlanItem = {
  text: string;
  status: PlanStatus;
};

/** A shell command the agent ran, with its real exit status when the log records one. */
export type CommandRun = {
  command: string;
  status: VerificationStatus;
  exitCode?: number;
  /** First meaningful error line from a failed run. */
  errorLine?: string;
  /** Position in the session event stream, used to order runs against edits. */
  seq: number;
};

export type FileEdit = {
  path: string;
  seq: number;
};

export type VerificationSummary = {
  status: VerificationStatus;
  commands: VerificationCommand[];
  gaps: string[];
};

export type RepoStats = {
  dirtyFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  additions: number;
  deletions: number;
};

export type ContextSignal = {
  kind: "decision" | "constraint" | "risk" | "anchor";
  text: string;
};

export type ProvenanceKind = "user-authored" | "transcript-derived" | "diff-derived" | "command-derived" | "ai-inferred";

export type ProvenanceLabel = {
  kind: ProvenanceKind;
  confidence: "high" | "medium" | "low";
  source: string;
};

export type MemoryFact = {
  id: string;
  text: string;
  provenance: ProvenanceLabel;
};

export type StableIdentity = {
  taskId: string;
  repoId: string;
  branchId: string;
  commitId: string;
  handoffId: string;
  sessionId?: string;
  sourceAgent?: SourceAgent;
};

export type TeamSyncPolicy = {
  mode: "local-only" | "sync-ready";
  rawTranscript: "included" | "excluded";
  filePreviewRedaction: "enabled";
  secretsRedaction: "enabled";
  userControlledSync: true;
};

export type EngineeringMemory = {
  version: 1;
  identity: StableIdentity;
  /** Present on packets captured before v0.2; no longer written. */
  positioning?: {
    category: string;
    buyer: string;
    moat: string;
  };
  intent: MemoryFact[];
  decisions: MemoryFact[];
  constraints: MemoryFact[];
  verification: MemoryFact[];
  risks: MemoryFact[];
  nextActions: MemoryFact[];
  changedFiles: MemoryFact[];
  teamSync: TeamSyncPolicy;
};

export type AgentSignal = {
  source: SourceAgent | "unknown";
  path: string;
  modifiedAt: string;
  snippets: string[];
};

export type SourceAgent = "codex" | "claude" | "gemini" | "antigravity";

export type TranscriptEntry = {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  timestamp?: string;
  kind?: string;
};

export type SourceSession = {
  source: SourceAgent;
  id: string;
  path: string;
  cwd?: string;
  updatedAt: string;
  matchedCwd: boolean;
  lineCount: number;
  transcript: TranscriptEntry[];
  transcriptExcerpt: string;
  threadName?: string;
  supplementalPaths?: string[];
  /** Latest structured plan the agent maintained (TodoWrite, update_plan, task tools). */
  plan?: PlanItem[];
  /** Latest plan the agent proposed in prose (ExitPlanMode, plan mode). */
  planText?: string;
  commands?: CommandRun[];
  edits?: FileEdit[];
  /** Summary the agent wrote when it compacted earlier context. */
  compactSummary?: string;
  links?: string[];
};

export type HandoffSections = {
  goal: string;
  currentStatus: string[];
  completed: string[];
  inProgress: string[];
  todos: string[];
  blockers: string[];
  filesTouched: string[];
  commandsRun: string[];
  errors: string[];
  decisions: string[];
  doNotRepeat: string[];
  nextBestAction: string;
};

export type HandoffContinuitySummary = {
  version: 1;
  originalQuestion: string;
  latestUserInstruction: string;
  latestAssistantSummary: string;
  agentPlan: string;
  workPhase: WorkPhase;
  verification: VerificationSummary;
  repoStats: RepoStats;
  contextSignals: ContextSignal[];
  completedWork: string[];
  inProgressWork: string[];
  remainingWork: string[];
  blockers: string[];
  nextAction: string;
  fileChanges: FileChange[];
  commandsRun: string[];
  errors: string[];
  decisions: string[];
  plan?: PlanItem[];
  constraints?: string[];
  title?: string;
  sourceSession?: {
    source: SourceAgent;
    id: string;
    cwd?: string;
    matchedCwd: boolean;
    updatedAt: string;
    transcriptItems: number;
  };
  repo: {
    repoPath: string;
    branch: string;
    commit: string;
    isGitRepo: boolean;
  };
};

export type HandoffPacket = {
  id: string;
  task: string;
  createdAt: string;
  targetAgent?: string;
  repo: GitSnapshot;
  sources: AgentSignal[];
  sourceSession?: SourceSession;
  sections: HandoffSections;
  handoffSummary?: HandoffContinuitySummary;
  engineeringMemory?: EngineeringMemory;
  markdown: string;
  markdownPath: string;
  /** Estimated tokens in `markdown`. */
  tokenEstimate?: number;
};

export type HandoffSummary = {
  id: string;
  task: string;
  createdAt: string;
  repoPath: string;
  branch: string;
  commit: string;
  markdownPath: string;
  nextBestAction: string;
  blockers: string[];
  filesTouched: string[];
  status: string[];
};

/** Compact view of a handoff for the web UI's lists and charts. */
export type HandoffListItem = {
  id: string;
  task: string;
  createdAt: string;
  title?: string;
  source?: SourceAgent;
  sessionId?: string;
  targetAgent?: string;
  repoPath: string;
  repoName: string;
  branch: string;
  commit: string;
  isGitRepo: boolean;
  phase: WorkPhase;
  objective: string;
  nextAction: string;
  verification: VerificationStatus;
  checks: { passed: number; failed: number; unknown: number };
  plan: { total: number; completed: number; inProgress: number };
  files: { count: number; additions: number; deletions: number; paths: string[] };
  blockers: number;
  tokens: number;
  transcriptItems: number;
};

export type UiStatus = {
  version: string;
  home: string;
  handoffCount: number;
  taskCount: number;
  packCount: number;
  /** Newest handoff time; the UI polls this to pick up new captures. */
  latestAt?: string;
  agents: Record<SourceAgent, boolean>;
};

export type ContextBlockCategory =
  | "intent"
  | "instruction"
  | "decision"
  | "constraint"
  | "verification"
  | "risk"
  | "next-action"
  | "changed-file"
  | "transcript";

export type ContextBlock = {
  id: string;
  sourceHandoffId: string;
  sourceTask: string;
  sourceCreatedAt: string;
  category: ContextBlockCategory;
  title: string;
  text: string;
  provenance: ProvenanceLabel;
  estimatedChars: number;
};

export type ContextPackItem = {
  id: string;
  blockId: string;
  block: ContextBlock;
  order: number;
  enabled: boolean;
};

export type ContextPack = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  includeRawTranscript: boolean;
  items: ContextPackItem[];
};

export type ContextPackOutput = {
  pack: ContextPack;
  markdown: string;
  json: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    includeRawTranscript: boolean;
    estimatedChars: number;
    estimatedTokens: number;
    warnings: string[];
    items: ContextPackItem[];
  };
  estimatedChars: number;
  estimatedTokens: number;
  warnings: string[];
};
