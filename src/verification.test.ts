/**
 * Boundary tests grounded in Leetcoder `verification.ts`, `orchestrator.ts`,
 * and `database.ts`, plus LongHorizon-Harness' strict auditor header contract.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isVerificationAccepted, parseVerificationReport, workspaceFingerprint } from "./verification.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verification boundary", () => {
  test("accepts the exact three-line header and rejects a prefaced verdict", () => {
    const evidence = `{"summary":"checked","completed":["fact"],"missing":[],"blockers":[],"actionGuidance":[],"evidence":[{"claim":"fact","artifact":"file","observation":"present"}]}`;
    const accepted = parseVerificationReport(`Status: complete\nIntegrity: clean\nContract audit: aligned\n${evidence}`);
    const prefaced = parseVerificationReport(`Here is the audit:\nStatus: complete\nIntegrity: clean\nContract audit: aligned\n${evidence}`);
    expect(accepted.status).toBe("complete");
    expect(isVerificationAccepted(accepted)).toBe(true);
    expect(prefaced.status).toBe("incomplete");
    expect(prefaced.contractAudit).toBe("unknown");
  });

  test("rejects aligned headers when accepted facts lack exact evidence", () => {
    const report = parseVerificationReport(`Status: complete\nIntegrity: clean\nContract audit: aligned\n{"summary":"checked","completed":["fact"],"missing":[],"blockers":[],"actionGuidance":[],"evidence":[{"claim":"similar fact","artifact":"file","observation":"present"}]}`);
    expect(isVerificationAccepted(report)).toBe(false);
  });

  test("fingerprints untracked contents, not only untracked names", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "leetcoder-verification-"));
    roots.push(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "verification@example.invalid"]);
    git(root, ["config", "user.name", "Leetcoder Verification"]);
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-qm", "base"]);
    writeFileSync(path.join(root, "untracked.txt"), "first\n");
    const first = workspaceFingerprint(root);
    writeFileSync(path.join(root, "untracked.txt"), "second\n");
    expect(workspaceFingerprint(root)).not.toBe(first);
  });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}
