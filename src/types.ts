export type JsonObject = Record<string, unknown>;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type TaskTemplate =
  | "implementation"
  | "bugfix"
  | "audit"
  | "refactor"
  | "tests"
  | "research"
  | "web"
  | "comparison";

export type SessionStatus =
  | "starting"
  | "running"
  | "handoff"
  | "completed"
  | "failed"
  | "paused"
  | "closing"
  | "closed";

export interface LeetcoderConfig {
  version: 1;
  listen: {
    host: string;
    port: number;
    tokenFile: string;
  };
  omp: {
    command: string;
    profile: string;
    maxWorkers: number;
    idleSeconds: number;
    provider?: string;
    model?: string;
    thinking?: ThinkingLevel;
  };
  paths: {
    dataRoot: string;
  };
  confirmation: {
    ttlMinutes: number;
  };
  history: {
    eventsPerSession: number;
  };
}

export interface PrepareRequest {
  title: string;
  task: string;
  template: TaskTemplate;
  repository?: string;
  baseRef?: string;
  files?: string[];
}

export interface PendingDelegation {
  token: string;
  title: string;
  task: string;
  template: TaskTemplate;
  repository: string | null;
  repositoryRoot: string | null;
  baseRef: string;
  baseCommit: string | null;
  dirtyFiles: number;
  files: string[];
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface SessionRecord {
  id: string;
  title: string;
  task: string;
  template: TaskTemplate;
  sourceRepo: string | null;
  worktree: string;
  branch: string;
  baseRef: string;
  baseCommit: string | null;
  files: string[];
  status: SessionStatus;
  phase: string;
  sessionPath: string | null;
  ompSessionId: string | null;
  lastOutput: string;
  lastError: string | null;
  handoffComplete: boolean;
  handoffSuggestedPath: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  closedAt: number | null;
}

export interface SessionEvent {
  id: number;
  sessionId: string;
  kind: string;
  body: JsonObject;
  createdAt: number;
}

export interface WorkspaceInfo {
  sourceRepo: string | null;
  worktree: string;
  branch: string;
  baseRef: string;
  baseCommit: string | null;
}

export interface OmpWorkerOptions {
  key: string;
  command: string;
  profile: string;
  cwd: string;
  systemPromptPath: string;
  sessionPath?: string | null;
  provider?: string | null;
  model?: string | null;
  thinking?: ThinkingLevel | null;
  advisor: boolean;
  onSession: (path: string, id: string) => void;
  onEvent: (event: JsonObject) => void;
  onUiRequest: (request: JsonObject) => Promise<JsonObject>;
  onExit?: () => void;
}

export interface OmpRunResult {
  text: string;
  sessionPath: string | null;
  sessionId: string;
}
