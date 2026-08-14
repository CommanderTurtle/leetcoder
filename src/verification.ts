/**
 * Independent milestone verification for a Leetcoder root.
 *
 * This boundary is deliberately derived from existing mechanisms rather than
 * introducing a third continuation engine:
 * - LongHorizon-Harness `types.py`, `auditor_agent.py`, and `manager.py` supply
 *   the fail-closed three-line control header and accepted-state rule.
 * - Prime Agent `refinement.ts` supplies baseline conflict detection and the
 *   separation between a proposed result and an accepted result.
 * - OMP `goals/runtime.ts` and `task/structured-subagent.ts` remain the owners
 *   of continuation, bounded execution, schemas, and isolation.
 * - Leetcoder `orchestrator.ts`, `database.ts`, and `rpc.ts` supply the durable
 *   cross-harness session, fresh RPC worker, and worktree boundary.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import path from "node:path";
import type {
  AuditEvidence,
  AuditIntegrity,
  AuditStatus,
  ContractAudit,
  SessionRecord,
  VerificationReport,
} from "./types.ts";

const STATUS = new Set<AuditStatus>(["complete", "incomplete", "blocked"]);
const INTEGRITY = new Set<AuditIntegrity>(["clean", "suspect", "violation"]);
const CONTRACT = new Set<ContractAudit>(["aligned", "unknown", "needs_revision", "invalid"]);

export function verificationPrompt(session: SessionRecord, claimedResult: string, round: number): string {
  return `Independently audit Leetcoder milestone ${round} for the following delegation.

You are a fresh, read-only verifier. The acting agent's summary is an untrusted claim, not evidence. Inspect the actual worktree, repository instructions, git status/diff, relevant source, and proportionate validation. You may run read-only shell inspection and tests, but you must not edit, format, install, generate, clean, commit, or delete anything. Do not call MCP tools or spawn another agent.

Original contract:
${session.task}

Worktree: ${session.worktree}
Branch: ${session.branch}
Base commit: ${session.baseCommit ?? "standalone workspace initial commit"}

Acting agent's claimed result:
${truncate(claimedResult || "(no completion claim was emitted)", 16_000)}

Your response MUST begin with exactly these three control lines, using only the listed values:
Status: complete | incomplete | blocked
Integrity: clean | suspect | violation
Contract audit: aligned | unknown | needs_revision | invalid

Then emit one JSON object with exactly this shape:
{
  "summary": "concise independent verdict",
  "completed": ["only facts directly supported by inspected evidence"],
  "missing": ["contract items not yet established"],
  "blockers": ["external blockers only"],
  "actionGuidance": ["specific repair instruction for the acting agent"],
  "evidence": [
    {"claim": "fact being checked", "artifact": "path, command, or observable", "observation": "what the evidence actually showed"}
  ]
}

Every string in "completed" must exactly equal one "evidence[].claim". Completion is valid only when the implementation satisfies the original contract, missing and blockers are empty, the workspace remains intact, and the evidence is sufficient. If output format or evidence is uncertain, fail closed as incomplete/unknown.`;
}

export function repairPrompt(session: SessionRecord, report: VerificationReport, round: number): string {
  const guidance = report.actionGuidance.length
    ? report.actionGuidance.map((item) => `- ${item}`).join("\n")
    : report.missing.map((item) => `- Resolve missing contract item: ${item}`).join("\n");
  return `Independent verification did not accept milestone ${round}. Continue the same delegation and repair the actual worktree; do not argue with the verdict or merely rewrite the summary.

Original objective:
${session.task}

Auditor verdict:
- Status: ${report.status}
- Integrity: ${report.integrity}
- Contract audit: ${report.contractAudit}
- Summary: ${report.summary}

Required action:
${guidance || "- Re-inspect the objective and produce evidence sufficient for a fresh verifier."}

The next verifier will be a fresh session and will inspect the environment independently.`;
}

export function parseVerificationReport(raw: string): VerificationReport {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const status = control(lines[0] ?? "", "Status") as AuditStatus;
  const integrity = control(lines[1] ?? "", "Integrity") as AuditIntegrity;
  const contractAudit = control(lines[2] ?? "", "Contract audit") as ContractAudit;
  if (!STATUS.has(status) || !INTEGRITY.has(integrity) || !CONTRACT.has(contractAudit)) {
    return malformed(raw, "Auditor response omitted or malformed the required control header");
  }
  const object = jsonObject(raw);
  if (!object) return malformed(raw, "Auditor response omitted the required JSON evidence object");
  const evidence = array(object.evidence).map((item) => {
    const record = asObject(item);
    return {
      claim: text(record.claim),
      artifact: text(record.artifact),
      observation: text(record.observation),
    };
  }).filter((item): item is AuditEvidence => Boolean(item.claim && item.artifact && item.observation));
  return {
    status,
    integrity,
    contractAudit,
    summary: text(object.summary) || "Auditor supplied no summary",
    completed: strings(object.completed),
    missing: strings(object.missing),
    blockers: strings(object.blockers),
    actionGuidance: strings(object.actionGuidance),
    evidence,
    raw,
  };
}

export function enforceWorkspaceIntegrity(
  report: VerificationReport,
  before: string,
  after: string,
): VerificationReport {
  if (before === after) return report;
  return {
    ...report,
    status: "incomplete",
    integrity: "violation",
    contractAudit: report.contractAudit === "aligned" ? "needs_revision" : report.contractAudit,
    summary: `${report.summary} The read-only auditor changed the worktree; its completion claim was rejected.`,
    actionGuidance: [
      "Inspect and reconcile workspace changes introduced during verification before another audit.",
      ...report.actionGuidance,
    ],
  };
}

export function isVerificationAccepted(report: VerificationReport): boolean {
  const evidenceClaims = new Set(report.evidence.map((item) => item.claim));
  return report.status === "complete"
    && report.integrity === "clean"
    && report.contractAudit === "aligned"
    && report.completed.length > 0
    && report.evidence.length > 0
    && report.missing.length === 0
    && report.blockers.length === 0
    && report.completed.every((fact) => evidenceClaims.has(fact));
}

export function workspaceFingerprint(worktree: string): string {
  const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const diff = git(worktree, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]);
  const digest = createHash("sha256").update(status).update("\0").update(diff);
  const untracked = gitBuffer(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8").split("\0").filter(Boolean).sort();
  for (const relative of untracked) hashUntracked(digest, worktree, relative);
  return digest.digest("hex");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Verification could not inspect git ${args[0]}: ${String(result.stderr || result.stdout).trim()}`);
  }
  return String(result.stdout || "");
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Verification could not inspect git ${args[0]}: ${String(result.stderr || result.stdout).trim()}`);
  }
  return Buffer.from(result.stdout || []);
}

function hashUntracked(digest: ReturnType<typeof createHash>, worktree: string, relative: string): void {
  const absolute = path.resolve(worktree, relative);
  const stat = lstatSync(absolute);
  digest.update("\0untracked\0").update(relative).update("\0").update(String(stat.mode));
  if (stat.isSymbolicLink()) {
    digest.update("\0symlink\0").update(readlinkSync(absolute));
    return;
  }
  if (!stat.isFile()) return;
  const fd = openSync(absolute, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      digest.update(chunk.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
}

function malformed(raw: string, reason: string): VerificationReport {
  return {
    status: "incomplete",
    integrity: "suspect",
    contractAudit: "unknown",
    summary: reason,
    completed: [],
    missing: ["A machine-readable independent audit was not established"],
    blockers: [],
    actionGuidance: ["Return the required three-line header followed by the specified JSON evidence object"],
    evidence: [],
    raw,
  };
}

function control(line: string, name: string): string {
  const prefix = `${name}:`;
  return line.toLowerCase().startsWith(prefix.toLowerCase())
    ? line.slice(prefix.length).trim().toLowerCase()
    : "";
}

function jsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return asObject(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return array(value).map(text).filter(Boolean).slice(0, 100);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n…[truncated]`;
}
