import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./paths.ts";
import type { PendingDelegation, WorkspaceInfo } from "./types.ts";

export interface RepositoryInspection {
  root: string | null;
  baseRef: string;
  baseCommit: string | null;
  dirtyFiles: number;
}

export function inspectRepository(repository: string | undefined, baseRef = "HEAD"): RepositoryInspection {
  if (!repository?.trim()) return { root: null, baseRef: "HEAD", baseCommit: null, dirtyFiles: 0 };
  const requested = expandHome(repository.trim());
  if (!existsSync(requested)) throw new Error(`Repository path does not exist: ${requested}`);
  const root = git(requested, ["rev-parse", "--show-toplevel"]).trim();
  const commit = git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  const dirty = git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean).length;
  return { root, baseRef, baseCommit: commit, dirtyFiles: dirty };
}

export function createWorkspace(dataRoot: string, pending: PendingDelegation): WorkspaceInfo {
  const id = sessionId();
  const repoLabel = slug(path.basename(pending.repositoryRoot || "research"));
  const worktree = path.join(dataRoot, "worktrees", repoLabel, id);
  const branch = `leetcoder/${slug(pending.title).slice(0, 36)}-${id.slice(-8)}`;
  mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  if (pending.repositoryRoot && pending.baseCommit) {
    git(pending.repositoryRoot, ["worktree", "add", "-b", branch, worktree, pending.baseCommit]);
    return {
      sourceRepo: pending.repositoryRoot,
      worktree,
      branch,
      baseRef: pending.baseRef,
      baseCommit: pending.baseCommit,
    };
  }
  mkdirSync(worktree, { recursive: false, mode: 0o700 });
  git(worktree, ["init", "--initial-branch", branch]);
  git(worktree, ["-c", "user.name=Leetcoder", "-c", "user.email=leetcoder@localhost", "commit", "--allow-empty", "-m", "Initialize Leetcoder research workspace"]);
  const commit = git(worktree, ["rev-parse", "HEAD"]).trim();
  return { sourceRepo: null, worktree, branch, baseRef: "HEAD", baseCommit: commit };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || "unknown git error"}`.trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
  return String(result.stdout || "");
}

function sessionId(): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}
