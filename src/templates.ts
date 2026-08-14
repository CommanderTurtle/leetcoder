import type { SessionRecord, SubagentRecord, TaskTemplate, VerificationRecord, VerifiedFact } from "./types.ts";

const TEMPLATE_GUIDANCE: Record<TaskTemplate, string> = {
  implementation: `Implement the requested capability completely. Inspect the surrounding architecture before editing, preserve established conventions, account for lifecycle and failure paths, and leave a cohesive finished change rather than scaffolding or TODOs.`,
  bugfix: `Reproduce the failure logically from code and available evidence, identify the root cause, make the narrowest complete correction, and inspect adjacent paths for the same defect. Do not paper over symptoms or discard unrelated work.`,
  audit: `Perform an evidence-backed audit. Trace actual behavior through source and configuration, rank concrete findings by impact, and make edits only when the delegation explicitly authorizes remediation. Avoid invented quotas or ceremonial tests.`,
  refactor: `Refactor without changing externally observable behavior unless the task explicitly requires it. Remove duplication and legacy paths, preserve public contracts, and keep the result readable, minimal, and native to the repository.`,
  tests: `Design or repair focused validation around the specified behavior. Prefer deterministic, high-signal checks tied to real contracts. Do not inflate coverage with redundant assertions or modify product behavior merely to satisfy a test.`,
  research: `Investigate the question using primary sources and local evidence. Distinguish verified facts from inference, keep source links or exact repository references, and produce an actionable conclusion rather than an unfiltered research dump.`,
  web: `Use the configured Firecrawl search/research tools for discovery and Camofox for stateful visual or interactive browsing. Complete the requested web task carefully, preserve evidence, and never substitute Puppeteer or hosted search fallbacks.`,
  comparison: `Compare the named implementations against explicit dimensions and real source behavior. Identify transferable ideas, incompatibilities, and the smallest justified recommendation. Do not equate popularity or verbosity with quality.`,
};

export function initialPrompt(session: SessionRecord): string {
  const files = session.files.length ? session.files.map((file) => `- ${file}`).join("\n") : "- No file restriction was supplied; remain within the delegated repository and task.";
  return `# Leetcoder delegation: ${session.title}

You are the accountable root implementation agent for this isolated delegation. Work autonomously to a finished state inside the current worktree, using OMP's native task swarm only when specialist delegation materially improves the result.

## Objective

${session.task}

## Assignment profile: ${session.template}

${TEMPLATE_GUIDANCE[session.template]}

## Scope

- Worktree: ${session.worktree}
- Branch: ${session.branch}
- Source repository: ${session.sourceRepo || "standalone research workspace"}
- Base: ${session.baseRef}${session.baseCommit ? ` (${session.baseCommit})` : ""}
- Requested files or areas:
${files}

## Execution contract

1. Inspect before editing and use the repository's own instructions and native tooling.
2. Make every safe in-scope decision yourself; do not ask the parent Hermes session routine questions.
3. You may use OMP's normal tools, Firecrawl, Camofox, Retrieval, Codebase Memory, and Librarian as useful.
4. Never mutate the source checkout or unrelated paths. All code changes belong in this worktree.
5. Preserve user changes. Do not reset, force-clean, delete branches, or rewrite existing history.
6. Run only proportionate validation demanded by the work. The absence of a test quota is deliberate.
7. Do not stop at a plan, TODO list, or partial scaffold. Complete the task or report the exact blocker with evidence.
8. End with a compact account of changes, files, validation, and any unresolved risk. The gateway will then request a durable Librarian handoff.

## Native OMP swarm contract

- Elect direct work for cohesive or small changes. Elect the native \`task\` tool for bounded research, review, implementation, or audit work that benefits from a specialist.
- Before spawning, inspect the native \`hub\` roster and reuse or redirect a relevant existing agent. Do not duplicate active or parked work.
- Give every child a stable descriptive name and a self-contained assignment: child sessions do not inherit this conversation transcript.
- Use \`task.batch\` only for genuinely independent fan-out. Respect the configured concurrency and recursion bounds; never construct an uncontrolled agent tree.
- Use OMP isolation for child edits when appropriate. Child patches or branches must merge into this outer Leetcoder worktree, which remains the canonical draft.
- Communicate follow-up direction through \`hub\` so a child retains its context. Read \`agent://\` outputs and \`history://\` transcripts rather than respawning equivalent work.
- You remain responsible for reconciling every child result, resolving conflicts, finishing the implementation, and reporting a single truthful outcome.
`;
}

export function handoffPrompt(
  session: SessionRecord,
  finalOutput: string,
  retry: boolean,
  subagents: SubagentRecord[] = [],
  verification: VerificationRecord | null = null,
  verifiedFacts: VerifiedFact[] = [],
): string {
  const prefix = retry
    ? "The required durable handoff was not observed. Do this now; do not merely describe it."
    : "The implementation turn is complete. Create its mandatory durable handoff now.";
  return `${prefix}

Call the MCP tool \`mcp__librarian_memory_add\` exactly once with a concise but complete OKF handoff. This is required even for a one-file or research-only delegation.

Use this suggested path:

${session.handoffSuggestedPath}

The content must include:

- delegation title and objective;
- source repository, worktree, branch, and base commit;
- decisions and architecture actually used;
- every changed file and its purpose;
- native OMP subagents used, their roles, relevant \`agent://\` artifacts and \`history://\` transcripts, or an explicit note that the root elected direct execution;
- validation performed and its result;
- independent verification verdict and the accepted-fact ledger below;
- unresolved blockers, risks, or follow-ups;
- enough context for another agent to resume without reconstructing this session.

Do not edit project files during this handoff unless correcting a factual omission you just discovered. After the tool succeeds, reply with the stored handoff path and nothing ceremonial.

For reference, your prior completion summary was:

${truncate(finalOutput || "(no assistant summary was emitted)", 12_000)}

Native swarm record captured by Leetcoder:

${renderSwarmRecord(subagents)}

Independent verification boundary:

${renderVerification(verification, verifiedFacts)}
`;
}

export function recoveryPrompt(session: SessionRecord, message?: string, subagents: SubagentRecord[] = []): string {
  return `Resume the Leetcoder delegation \"${session.title}\" from its saved OMP session and current worktree. Inspect the actual repository state before acting; the gateway restarted and no in-flight assumption is trustworthy.

Original objective:
${session.task}

${message ? `New direction from Hermes:\n${message}\n` : "Continue from the last safe point and finish the original objective."}

Prior native subagent record:
${renderSwarmRecord(subagents)}

Run \`hub\` roster/list before creating another child. Reuse a relevant live or parked agent through \`hub\`; if the gateway restart made it unavailable, consult its \`agent://\` output and \`history://\` transcript before electing a replacement.
`;
}

export function steeringPrompt(session: SessionRecord, message: string, subagents: SubagentRecord[]): string {
  return `Hermes steering for Leetcoder delegation "${session.title}":

${message}

Before spawning another native task agent, inspect the \`hub\` roster and reuse a relevant existing child. Known child record:
${renderSwarmRecord(subagents)}

Apply this direction at the nearest safe boundary while keeping the outer Leetcoder worktree authoritative.`;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n…[truncated]`;
}

function renderSwarmRecord(subagents: SubagentRecord[]): string {
  if (subagents.length === 0) return "- No native task subagents recorded; the root elected direct execution so far.";
  return subagents.map((subagent) => {
    const task = truncate(subagent.task || subagent.description || "assignment details unavailable", 280).replace(/\s+/g, " ");
    return `- ${subagent.id} [${subagent.agent}; ${subagent.status}] — ${task}\n  Artifact: ${agentUri(subagent.id)}\n  Transcript: history://${subagent.id}`;
  }).join("\n");
}

function agentUri(id: string): string {
  const [root, ...children] = id.split(".");
  return children.length ? `agent://${root}/${children.join("/")}` : `agent://${id}`;
}

function renderVerification(verification: VerificationRecord | null, facts: VerifiedFact[]): string {
  if (!verification) return "- Verification disabled for this session; acting-agent claims remain explicitly unverified.";
  const evidence = verification.evidence.length
    ? verification.evidence.map((item) => `  - ${item.claim} — ${item.artifact}: ${item.observation}`).join("\n")
    : "  - No evidence entries recorded.";
  const ledger = facts.length
    ? facts.map((item) => `  - ${item.fact}`).join("\n")
    : "  - No facts were accepted.";
  return `- Round: ${verification.round}
- Status: ${verification.status}
- Integrity: ${verification.integrity}
- Contract audit: ${verification.contractAudit}
- Summary: ${verification.summary}
- Evidence:
${evidence}
- Accepted facts:
${ledger}`;
}
