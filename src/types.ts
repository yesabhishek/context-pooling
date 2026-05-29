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

export type WorkPhase = "planning" | "implementation" | "debugging" | "verification" | "blocked" | "handoff";

export type VerificationStatus = "passed" | "failed" | "unknown";

export type VerificationCommand = {
  command: string;
  status: VerificationStatus;
  evidence?: string;
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
  positioning: {
    category: "handoff-ledger";
    buyer: "ai-heavy-engineering-teams";
    moat: "provenance-backed-engineering-memory";
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
  source: "codex" | "claude" | "unknown";
  path: string;
  modifiedAt: string;
  snippets: string[];
};

export type SourceAgent = "codex" | "claude";

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
    warnings: string[];
    items: ContextPackItem[];
  };
  estimatedChars: number;
  warnings: string[];
};
