import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  JsonObject,
  PendingDelegation,
  PrepareRequest,
  SessionEvent,
  SessionRecord,
  SessionStatus,
  TaskTemplate,
  WorkspaceInfo,
} from "./types.ts";

export class LeetcoderDatabase {
  readonly db: Database;

  constructor(file: string, private readonly eventLimit: number) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA foreign_keys=ON");
    this.db.run("PRAGMA busy_timeout=5000");
    this.migrate();
    this.recoverInterruptedWork();
  }

  close(): void {
    this.db.close();
  }

  createPending(request: PrepareRequest, repository: {
    root: string | null;
    baseRef: string;
    baseCommit: string | null;
    dirtyFiles: number;
  }, ttlMinutes: number): PendingDelegation {
    const now = Date.now();
    const pending: PendingDelegation = {
      token: crypto.randomUUID(),
      title: request.title,
      task: request.task,
      template: request.template,
      repository: request.repository || null,
      repositoryRoot: repository.root,
      baseRef: repository.baseRef,
      baseCommit: repository.baseCommit,
      dirtyFiles: repository.dirtyFiles,
      files: request.files || [],
      createdAt: now,
      expiresAt: now + ttlMinutes * 60_000,
      consumedAt: null,
    };
    this.db.query(`
      INSERT INTO pending_delegations (
        token, title, task, template, repository, repository_root, base_ref,
        base_commit, dirty_files, files_json, created_at, expires_at, consumed_at
      ) VALUES (
        $token, $title, $task, $template, $repository, $repositoryRoot, $baseRef,
        $baseCommit, $dirtyFiles, $filesJson, $createdAt, $expiresAt, NULL
      )
    `).run({
      token: pending.token,
      title: pending.title,
      task: pending.task,
      template: pending.template,
      repository: pending.repository,
      repositoryRoot: pending.repositoryRoot,
      baseRef: pending.baseRef,
      baseCommit: pending.baseCommit,
      dirtyFiles: pending.dirtyFiles,
      filesJson: JSON.stringify(pending.files),
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
    });
    return pending;
  }

  consumePending(token: string): PendingDelegation {
    const consume = this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM pending_delegations WHERE token = $token").get({ token }) as Row | null;
      if (!row) throw new Error("Unknown Leetcoder confirmation token");
      const pending = mapPending(row);
      if (pending.consumedAt) throw new Error("This Leetcoder delegation was already confirmed");
      if (pending.expiresAt < Date.now()) throw new Error("This Leetcoder delegation confirmation has expired");
      const consumedAt = Date.now();
      this.db.query("UPDATE pending_delegations SET consumed_at = $consumedAt WHERE token = $token").run({
        consumedAt: consumedAt,
        token: token,
      });
      return { ...pending, consumedAt };
    });
    return consume();
  }

  expirePending(): number {
    const result = this.db.query(
      "DELETE FROM pending_delegations WHERE (expires_at < $now OR consumed_at IS NOT NULL) AND created_at < $cutoff"
    ).run({ now: Date.now(), cutoff: Date.now() - 24 * 60 * 60 * 1000 });
    return result.changes;
  }

  createSession(pending: PendingDelegation, workspace: WorkspaceInfo): SessionRecord {
    const now = Date.now();
    const id = path.basename(workspace.worktree);
    const handoffSuggestedPath = `/leetcoder/${slug(path.basename(workspace.sourceRepo || "research"))}/${id}.md`;
    this.db.query(`
      INSERT INTO sessions (
        id, title, task, template, source_repo, worktree, branch, base_ref,
        base_commit, files_json, status, phase, session_path, omp_session_id,
        last_output, last_error, handoff_complete, handoff_suggested_path,
        created_at, updated_at, completed_at, closed_at
      ) VALUES (
        $id, $title, $task, $template, $sourceRepo, $worktree, $branch, $baseRef,
        $baseCommit, $filesJson, 'starting', 'bootstrap', NULL, NULL,
        '', NULL, 0, $handoffSuggestedPath, $now, $now, NULL, NULL
      )
    `).run({
      id: id,
      title: pending.title,
      task: pending.task,
      template: pending.template,
      sourceRepo: workspace.sourceRepo,
      worktree: workspace.worktree,
      branch: workspace.branch,
      baseRef: workspace.baseRef,
      baseCommit: workspace.baseCommit,
      filesJson: JSON.stringify(pending.files),
      handoffSuggestedPath: handoffSuggestedPath,
      now: now,
    });
    return this.getSession(id);
  }

  getSession(id: string): SessionRecord {
    const row = this.db.query("SELECT * FROM sessions WHERE id = $id").get({ id }) as Row | null;
    if (!row) throw new Error(`Unknown Leetcoder session: ${id}`);
    return mapSession(row);
  }

  listSessions(limit = 100): SessionRecord[] {
    return (this.db.query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT $limit").all({ limit }) as Row[]).map(mapSession);
  }

  activeSessions(): SessionRecord[] {
    return (this.db.query(`
      SELECT * FROM sessions
      WHERE status IN ('starting', 'running', 'handoff', 'paused', 'closing')
      ORDER BY updated_at DESC
    `).all() as Row[]).map(mapSession);
  }

  countExecuting(): number {
    const row = this.db.query(`
      SELECT count(*) AS value FROM sessions
      WHERE status IN ('starting', 'running', 'handoff', 'closing')
    `).get() as { value: number };
    return Number(row.value);
  }

  setStatus(id: string, status: SessionStatus, phase: string, error: string | null = null): void {
    const now = Date.now();
    const completedAt = status === "completed" ? now : null;
    const closedAt = status === "closed" ? now : null;
    this.db.query(`
      UPDATE sessions SET status = $status, phase = $phase, last_error = $error,
        updated_at = $now,
        completed_at = CASE WHEN $completedAt IS NULL THEN completed_at ELSE $completedAt END,
        closed_at = CASE WHEN $closedAt IS NULL THEN closed_at ELSE $closedAt END
      WHERE id = $id
    `).run({
      status: status,
      phase: phase,
      error: error,
      now: now,
      completedAt: completedAt,
      closedAt: closedAt,
      id: id,
    });
  }

  setSessionIdentity(id: string, sessionPath: string, ompSessionId: string): void {
    this.db.query(`
      UPDATE sessions SET session_path = $sessionPath, omp_session_id = $ompSessionId,
        updated_at = $now WHERE id = $id
    `).run({ sessionPath, ompSessionId, now: Date.now(), id });
  }

  setLastOutput(id: string, output: string): void {
    this.db.query("UPDATE sessions SET last_output = $output, updated_at = $now WHERE id = $id").run({
      output: truncate(output, 100_000),
      now: Date.now(),
      id: id,
    });
  }

  resetHandoff(id: string): void {
    this.db.query("UPDATE sessions SET handoff_complete = 0, updated_at = $now WHERE id = $id").run({
      now: Date.now(),
      id: id,
    });
  }

  markHandoffComplete(id: string): void {
    this.db.query("UPDATE sessions SET handoff_complete = 1, updated_at = $now WHERE id = $id").run({
      now: Date.now(),
      id: id,
    });
  }

  enqueueFollowUp(sessionId: string, message: string): number {
    const result = this.db.query(`
      INSERT INTO followups (session_id, message, status, created_at, updated_at)
      VALUES ($sessionId, $message, 'queued', $now, $now)
    `).run({ sessionId, message, now: Date.now() });
    return Number(result.lastInsertRowid);
  }

  takeNextFollowUp(sessionId: string): { id: number; message: string } | null {
    const take = this.db.transaction(() => {
      const row = this.db.query(`
        SELECT id, message FROM followups
        WHERE session_id = $sessionId AND status = 'queued'
        ORDER BY id ASC LIMIT 1
      `).get({ sessionId }) as { id: number; message: string } | null;
      if (!row) return null;
      this.db.query("UPDATE followups SET status = 'running', updated_at = $now WHERE id = $id").run({
        now: Date.now(),
        id: Number(row.id),
      });
      return { id: Number(row.id), message: String(row.message) };
    });
    return take();
  }

  finishFollowUp(id: number, ok: boolean): void {
    this.db.query("UPDATE followups SET status = $status, updated_at = $now WHERE id = $id").run({
      status: ok ? "done" : "failed",
      now: Date.now(),
      id: id,
    });
  }

  queuedFollowUpCount(sessionId: string): number {
    const row = this.db.query("SELECT count(*) AS value FROM followups WHERE session_id = $sessionId AND status = 'queued'").get({
      sessionId: sessionId,
    }) as { value: number };
    return Number(row.value);
  }

  sessionsWithQueuedFollowUps(): string[] {
    const rows = this.db.query(`
      SELECT DISTINCT session_id FROM followups WHERE status = 'queued' ORDER BY session_id
    `).all() as Array<{ session_id: string }>;
    return rows.map((row) => String(row.session_id));
  }

  addEvent(sessionId: string, kind: string, body: JsonObject): void {
    this.db.query("INSERT INTO events (session_id, kind, body_json, created_at) VALUES ($sessionId, $kind, $body, $now)").run({
      sessionId: sessionId,
      kind: kind,
      body: JSON.stringify(limitEvent(body)),
      now: Date.now(),
    });
    this.db.query(`
      DELETE FROM events WHERE session_id = $sessionId AND id NOT IN (
        SELECT id FROM events WHERE session_id = $sessionId ORDER BY id DESC LIMIT $limit
      )
    `).run({ sessionId, limit: this.eventLimit });
  }

  events(sessionId: string, limit = 40): SessionEvent[] {
    const rows = this.db.query(`
      SELECT * FROM (
        SELECT * FROM events WHERE session_id = $sessionId ORDER BY id DESC LIMIT $limit
      ) ORDER BY id ASC
    `).all({ sessionId, limit: Math.min(Math.max(limit, 1), 200) }) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: String(row.session_id),
      kind: String(row.kind),
      body: parseObject(row.body_json),
      createdAt: Number(row.created_at),
    }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_delegations (
        token TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        task TEXT NOT NULL,
        template TEXT NOT NULL,
        repository TEXT,
        repository_root TEXT,
        base_ref TEXT NOT NULL,
        base_commit TEXT,
        dirty_files INTEGER NOT NULL DEFAULT 0,
        files_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        task TEXT NOT NULL,
        template TEXT NOT NULL,
        source_repo TEXT,
        worktree TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_commit TEXT,
        files_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        session_path TEXT,
        omp_session_id TEXT,
        last_output TEXT NOT NULL DEFAULT '',
        last_error TEXT,
        handoff_complete INTEGER NOT NULL DEFAULT 0,
        handoff_suggested_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        closed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS followups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_pending_expiry ON pending_delegations(expires_at);
      CREATE INDEX IF NOT EXISTS idx_followups_session_status ON followups(session_id, status, id);
    `);
  }

  private recoverInterruptedWork(): void {
    this.db.query(`
      UPDATE sessions SET status = 'paused', phase = 'recovered',
        last_error = 'Gateway restarted while this session was active; resume or follow up to continue.',
        updated_at = $now
      WHERE status IN ('starting', 'running', 'handoff', 'closing')
    `).run({ now: Date.now() });
    this.db.query("UPDATE followups SET status = 'queued', updated_at = $now WHERE status = 'running'").run({
      now: Date.now(),
    });
  }
}

type Row = Record<string, unknown>;

function mapPending(row: Row): PendingDelegation {
  return {
    token: String(row.token),
    title: String(row.title),
    task: String(row.task),
    template: String(row.template) as TaskTemplate,
    repository: nullable(row.repository),
    repositoryRoot: nullable(row.repository_root),
    baseRef: String(row.base_ref),
    baseCommit: nullable(row.base_commit),
    dirtyFiles: Number(row.dirty_files),
    files: parseStrings(row.files_json),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
  };
}

function mapSession(row: Row): SessionRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    task: String(row.task),
    template: String(row.template) as TaskTemplate,
    sourceRepo: nullable(row.source_repo),
    worktree: String(row.worktree),
    branch: String(row.branch),
    baseRef: String(row.base_ref),
    baseCommit: nullable(row.base_commit),
    files: parseStrings(row.files_json),
    status: String(row.status) as SessionStatus,
    phase: String(row.phase),
    sessionPath: nullable(row.session_path),
    ompSessionId: nullable(row.omp_session_id),
    lastOutput: String(row.last_output || ""),
    lastError: nullable(row.last_error),
    handoffComplete: Boolean(row.handoff_complete),
    handoffSuggestedPath: String(row.handoff_suggested_path),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
  };
}

function nullable(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseStrings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): JsonObject {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n…[truncated]`;
}

function limitEvent(value: JsonObject): JsonObject {
  const text = JSON.stringify(value);
  return text.length <= 64_000 ? value : { truncated: true, preview: text.slice(0, 64_000) };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "session";
}
