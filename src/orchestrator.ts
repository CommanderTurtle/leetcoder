import { spawnSync } from "node:child_process";
import path from "node:path";
import { LeetcoderDatabase } from "./database.ts";
import { createWorkspace, inspectRepository } from "./git.ts";
import { systemPromptPath } from "./paths.ts";
import { OmpWorkerPool, type OmpRpcWorker } from "./rpc.ts";
import { handoffPrompt, initialPrompt, recoveryPrompt } from "./templates.ts";
import type { JsonObject, LeetcoderConfig, PrepareRequest, SessionRecord } from "./types.ts";

const LIBRARIAN_ADD_TOOL = "mcp__librarian_memory_add";

export class LeetcoderOrchestrator {
  readonly db: LeetcoderDatabase;
  readonly workers: OmpWorkerPool;
  private readonly drains = new Set<string>();
  private reaper: ReturnType<typeof setInterval> | undefined;

  constructor(readonly config: LeetcoderConfig) {
    this.db = new LeetcoderDatabase(path.join(config.paths.dataRoot, "leetcoder.sqlite3"), config.history.eventsPerSession);
    this.workers = new OmpWorkerPool(config.omp.maxWorkers, config.omp.idleSeconds * 1000);
    this.reaper = setInterval(() => {
      this.db.expirePending();
      void this.workers.reapIdle();
    }, 60_000);
  }

  prepare(request: PrepareRequest): JsonObject {
    validatePrepare(request);
    const repository = inspectRepository(request.repository, request.baseRef || "HEAD");
    const pending = this.db.createPending(request, repository, this.config.confirmation.ttlMinutes);
    const active = this.db.activeSessions().map(sessionSummary);
    return {
      confirmationRequired: true,
      confirmationToken: pending.token,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      proposed: {
        title: pending.title,
        template: pending.template,
        task: pending.task,
        repository: pending.repositoryRoot || "standalone research workspace",
        baseRef: pending.baseRef,
        baseCommit: pending.baseCommit,
        requestedFiles: pending.files,
        uncommittedFilesExcluded: pending.dirtyFiles,
      },
      activeSessions: active,
      instruction:
        "Show this proposal and the active-session titles to the user. Start nothing until the user explicitly confirms; then call leetcoder_confirm with this token and confirmation='YES'.",
    };
  }

  confirm(token: string, confirmation: string): JsonObject {
    if (confirmation !== "YES") throw new Error("Leetcoder requires the exact confirmation value YES");
    if (this.db.countExecuting() >= this.config.omp.maxWorkers) {
      throw new Error(`All ${this.config.omp.maxWorkers} Leetcoder worker slots are active; close or await one before confirming another delegation`);
    }
    const pending = this.db.consumePending(token);
    const workspace = createWorkspace(this.config.paths.dataRoot, pending);
    const session = this.db.createSession(pending, workspace);
    this.db.addEvent(session.id, "delegation_confirmed", {
      title: session.title,
      worktree: session.worktree,
      branch: session.branch,
      baseCommit: session.baseCommit,
    });
    void this.runManagedTurn(session.id, initialPrompt(session), "initial");
    return {
      started: true,
      session: sessionSummary(session),
      worktree: session.worktree,
      branch: session.branch,
      note: "The OMP session is running in the background. Use leetcoder_inspect or leetcoder_list; use leetcoder_steer to alter active work.",
    };
  }

  list(includeClosed = false, limit = 100): JsonObject {
    const sessions = this.db.listSessions(limit)
      .filter((session) => includeClosed || session.status !== "closed")
      .map((session) => ({ ...sessionSummary(session), queuedFollowUps: this.db.queuedFollowUpCount(session.id) }));
    return { sessions, workerProcesses: this.workers.size };
  }

  inspect(id: string, eventLimit = 40): JsonObject {
    const session = this.db.getSession(id);
    return {
      session,
      queuedFollowUps: this.db.queuedFollowUpCount(id),
      worktreeStatus: gitStatus(session.worktree),
      events: this.db.events(id, eventLimit),
    };
  }

  async steer(id: string, message: string): Promise<JsonObject> {
    const session = this.db.getSession(id);
    if (!message.trim()) throw new Error("Steering message cannot be empty");
    if (!new Set(["starting", "running", "handoff", "closing"]).has(session.status)) {
      throw new Error(`Session ${id} is ${session.status}, not actively streaming. Use leetcoder_follow_up or leetcoder_resume.`);
    }
    const worker = this.workers.get(id);
    if (!worker?.isAlive) throw new Error(`Session ${id} has no live worker. Use leetcoder_resume to reopen its saved OMP session.`);
    await worker.steer(message.trim());
    this.db.addEvent(id, "hermes_steer", { message: message.trim() });
    return { accepted: true, session: id, status: this.db.getSession(id).status };
  }

  followUp(id: string, message: string): JsonObject {
    const session = this.db.getSession(id);
    if (!message.trim()) throw new Error("Follow-up message cannot be empty");
    if (session.status === "closed") throw new Error("A closed Leetcoder session cannot accept follow-ups; delegate a new session instead");
    const queueId = this.db.enqueueFollowUp(id, message.trim());
    this.db.addEvent(id, "hermes_follow_up_queued", { queueId, message: message.trim() });
    if (!isExecuting(session.status)) this.scheduleDrain(id);
    return {
      queued: true,
      queueId,
      session: id,
      ahead: this.db.queuedFollowUpCount(id) - 1,
      note: "Each follow-up is its own OMP turn and receives a fresh mandatory Librarian handoff.",
    };
  }

  resume(id: string, message?: string): JsonObject {
    const session = this.db.getSession(id);
    if (session.status === "closed") throw new Error("A closed Leetcoder session cannot be resumed");
    if (isExecuting(session.status)) throw new Error(`Session ${id} is already ${session.status}`);
    if (!session.sessionPath) throw new Error("This session never reached a persisted OMP session and cannot be resumed");
    const queueId = this.db.enqueueFollowUp(id, recoveryPrompt(session, message?.trim()));
    this.db.addEvent(id, "resume_queued", { queueId, message: message?.trim() || null });
    this.scheduleDrain(id);
    return { queued: true, queueId, session: id, priorStatus: session.status };
  }

  async closeSession(id: string, force: boolean): Promise<JsonObject> {
    const session = this.db.getSession(id);
    if (session.status === "closed") return { closed: true, alreadyClosed: true, session: id };
    const worker = this.workers.get(id);
    if (force) {
      this.db.setStatus(id, "closed", "force-closed", "Force-closed before a guaranteed Librarian handoff");
      this.db.addEvent(id, "force_closed", {});
      if (worker?.isAlive) await worker.abort().catch(() => undefined);
      await this.workers.drop(id);
      return { closed: true, forced: true, session: id, worktreePreserved: session.worktree, branchPreserved: session.branch };
    }
    if (worker?.isAlive && isExecuting(session.status)) {
      this.db.setStatus(id, "closing", "safe-boundary");
      await worker.steer(
        "Stop accepting new work. Reach the nearest safe repository state, summarize what is complete and incomplete, and end this turn. The gateway will require the Librarian handoff before closing."
      );
      this.db.addEvent(id, "graceful_close_requested", {});
      return { closing: true, session: id, note: "The session will close after its mandatory Librarian handoff." };
    }
    if (!worker && isExecuting(session.status)) {
      this.db.setStatus(id, "closing", "cancel-before-worker-start");
      this.db.addEvent(id, "graceful_close_requested", { workerStarted: false });
      return { closing: true, session: id, note: "The session will close before an OMP worker begins." };
    }
    this.db.setStatus(id, "closed", "closed");
    this.db.addEvent(id, "closed", {});
    await this.workers.drop(id);
    return { closed: true, forced: false, session: id, worktreePreserved: session.worktree, branchPreserved: session.branch };
  }

  resumeQueuedWork(): void {
    for (const id of this.db.sessionsWithQueuedFollowUps()) this.scheduleDrain(id);
  }

  health(): JsonObject {
    return {
      ok: true,
      service: "leetcoder",
      workers: this.workers.size,
      executing: this.db.countExecuting(),
      maxWorkers: this.config.omp.maxWorkers,
      profile: this.config.omp.profile,
      dataRoot: this.config.paths.dataRoot,
    };
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    this.reaper = undefined;
    await this.workers.close();
    this.db.close();
  }

  private scheduleDrain(id: string): void {
    if (this.drains.has(id)) return;
    this.drains.add(id);
    queueMicrotask(() => void this.drain(id));
  }

  private async drain(id: string): Promise<void> {
    try {
      while (true) {
        const session = this.db.getSession(id);
        if (session.status === "closed" || isExecuting(session.status)) return;
        const next = this.db.takeNextFollowUp(id);
        if (!next) return;
        await this.runManagedTurn(id, next.message, "follow-up", next.id);
        const refreshed = this.db.getSession(id);
        if (refreshed.status === "failed" || refreshed.status === "closed") return;
      }
    } finally {
      this.drains.delete(id);
      const session = this.db.getSession(id);
      if (!isExecuting(session.status) && session.status !== "closed" && this.db.queuedFollowUpCount(id) > 0) this.scheduleDrain(id);
    }
  }

  private async runManagedTurn(id: string, prompt: string, phase: string, followUpId?: number): Promise<void> {
    let worker: OmpRpcWorker | undefined;
    try {
      let session = this.db.getSession(id);
      this.db.setStatus(id, phase === "initial" ? "starting" : "running", phase);
      worker = await this.workers.acquire(this.workerOptions(session));
      const acquiredStatus = this.db.getSession(id).status;
      if (acquiredStatus === "closed" || acquiredStatus === "closing") {
        this.db.setStatus(id, "closed", "closed-before-turn");
        this.db.addEvent(id, "closed_before_turn", {});
        await this.workers.drop(id);
        if (followUpId) this.db.finishFollowUp(followUpId, false);
        return;
      }
      await worker.setSessionName(`Leetcoder: ${session.title}`);
      this.db.setStatus(id, "running", phase);
      this.db.addEvent(id, "turn_started", { phase, pid: worker.pid, followUpId: followUpId || null });
      const result = await worker.runPrompt(prompt);
      this.db.setSessionIdentity(id, result.sessionPath || worker.sessionPath || "", result.sessionId || worker.sessionId);
      this.db.setLastOutput(id, result.text);
      this.db.addEvent(id, "turn_finished", { phase, output: truncate(result.text, 20_000) });

      session = this.db.getSession(id);
      const closeAfterHandoff = session.status === "closing";
      this.db.resetHandoff(id);
      this.db.setStatus(id, "handoff", "librarian-handoff");
      let handoffResult = await worker.runPrompt(handoffPrompt(this.db.getSession(id), result.text, false));
      this.db.setLastOutput(id, handoffResult.text);
      if (!this.db.getSession(id).handoffComplete) {
        this.db.addEvent(id, "handoff_retry", { reason: `${LIBRARIAN_ADD_TOOL} did not complete successfully` });
        handoffResult = await worker.runPrompt(handoffPrompt(this.db.getSession(id), result.text, true));
        this.db.setLastOutput(id, handoffResult.text);
      }
      if (!this.db.getSession(id).handoffComplete) {
        throw new Error(`OMP completed the work but did not successfully call ${LIBRARIAN_ADD_TOOL} after two explicit requests`);
      }
      this.db.addEvent(id, "handoff_complete", {
        suggestedPath: this.db.getSession(id).handoffSuggestedPath,
        output: truncate(handoffResult.text, 12_000),
      });
      const shouldClose = closeAfterHandoff || this.db.getSession(id).status === "closing";
      this.db.setStatus(id, shouldClose ? "closed" : "completed", shouldClose ? "closed-after-handoff" : "complete");
      if (followUpId) this.db.finishFollowUp(followUpId, true);
      if (shouldClose) await this.workers.drop(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = safeSessionStatus(this.db, id);
      if (status !== "closed") {
        this.db.setStatus(id, "failed", "failed", message);
        this.db.addEvent(id, "turn_failed", { phase, error: message });
      }
      if (followUpId) this.db.finishFollowUp(followUpId, false);
    } finally {
      worker?.release();
      const status = safeSessionStatus(this.db, id);
      if (status && !isExecuting(status) && status !== "closed" && this.db.queuedFollowUpCount(id) > 0) this.scheduleDrain(id);
    }
  }

  private workerOptions(session: SessionRecord) {
    return {
      key: session.id,
      command: this.config.omp.command,
      profile: this.config.omp.profile,
      cwd: session.worktree,
      systemPromptPath: systemPromptPath(),
      ...(session.sessionPath ? { sessionPath: session.sessionPath } : {}),
      ...(this.config.omp.provider ? { provider: this.config.omp.provider } : {}),
      ...(this.config.omp.model ? { model: this.config.omp.model } : {}),
      ...(this.config.omp.thinking ? { thinking: this.config.omp.thinking } : {}),
      onSession: (sessionPath: string, ompSessionId: string) => {
        if (sessionPath) this.db.setSessionIdentity(session.id, sessionPath, ompSessionId);
      },
      onEvent: (event: JsonObject) => this.handleWorkerEvent(session.id, event),
      onUiRequest: async (request: JsonObject) => this.answerUiRequest(session.id, request),
      onExit: () => {
        const status = safeSessionStatus(this.db, session.id);
        if (status && isExecuting(status)) {
          this.db.setStatus(session.id, "paused", "worker-exited", "OMP worker exited; the persisted session can be resumed");
          this.db.addEvent(session.id, "worker_exited", {});
        }
      },
    };
  }

  private handleWorkerEvent(id: string, event: JsonObject): void {
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (new Set([
      "agent_start", "agent_end", "message_end", "tool_execution_start", "tool_execution_end",
      "subagent_lifecycle", "subagent_progress", "extension_error", "worker_stderr",
    ]).has(type)) {
      this.db.addEvent(id, type, compactEvent(event));
    }
    if (type === "tool_execution_end" && event.toolName === LIBRARIAN_ADD_TOOL && !toolFailed(event)) {
      const session = this.db.getSession(id);
      if (session.status === "handoff" || session.phase === "librarian-handoff") this.db.markHandoffComplete(id);
    }
  }

  private async answerUiRequest(id: string, request: JsonObject): Promise<JsonObject> {
    const method = typeof request.method === "string" ? request.method : "unknown";
    this.db.addEvent(id, "omp_ui_request", compactEvent(request));
    if (method === "confirm") return { confirmed: true };
    if (method === "select") {
      const options = Array.isArray(request.options) ? request.options.filter((item): item is string => typeof item === "string") : [];
      return options[0] ? { value: options[0] } : { cancelled: true };
    }
    if (method === "input") {
      const value = typeof request.defaultValue === "string" ? request.defaultValue : "";
      return { value };
    }
    if (method === "editor") return { value: typeof request.prefill === "string" ? request.prefill : "" };
    return { cancelled: true };
  }
}

function validatePrepare(request: PrepareRequest): void {
  if (!request.title.trim() || request.title.length > 120) throw new Error("Title must contain 1-120 characters");
  if (!request.task.trim() || request.task.length > 50_000) throw new Error("Task must contain 1-50,000 characters");
  const templates = new Set(["implementation", "bugfix", "audit", "refactor", "tests", "research", "web", "comparison"]);
  if (!templates.has(request.template)) throw new Error(`Unknown Leetcoder template: ${request.template}`);
  if ((request.files || []).length > 200) throw new Error("A delegation may name at most 200 files or areas");
}

function sessionSummary(session: SessionRecord): JsonObject {
  return {
    id: session.id,
    title: session.title,
    template: session.template,
    status: session.status,
    phase: session.phase,
    branch: session.branch,
    worktree: session.worktree,
    updatedAt: new Date(session.updatedAt).toISOString(),
    handoffComplete: session.handoffComplete,
  };
}

function isExecuting(status: string): boolean {
  return new Set(["starting", "running", "handoff", "closing"]).has(status);
}

function safeSessionStatus(db: LeetcoderDatabase, id: string): string | null {
  try {
    return db.getSession(id).status;
  } catch {
    return null;
  }
}

function compactEvent(event: JsonObject): JsonObject {
  const copy: JsonObject = {};
  for (const key of ["type", "toolCallId", "toolName", "args", "result", "isError", "error", "message", "text", "subagentId", "status", "progress"]) {
    if (key in event) copy[key] = event[key];
  }
  return copy;
}

function toolFailed(event: JsonObject): boolean {
  if (event.isError === true) return true;
  const result = event.result;
  return Boolean(result && typeof result === "object" && !Array.isArray(result) && (result as JsonObject).isError === true);
}

function gitStatus(worktree: string): JsonObject {
  const result = spawnSync("git", ["status", "--short", "--branch"], {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0
    ? { ok: true, text: String(result.stdout || "").trim() }
    : { ok: false, error: String(result.stderr || result.stdout || "git status failed").trim() };
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n…[truncated]`;
}
