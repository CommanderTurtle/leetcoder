import type { SessionRecord, TaskTemplate } from "./types.ts";

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

You are the sole implementation agent for this isolated delegation. Work autonomously to a finished state inside the current worktree.

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
`;
}

export function handoffPrompt(session: SessionRecord, finalOutput: string, retry: boolean): string {
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
- validation performed and its result;
- unresolved blockers, risks, or follow-ups;
- enough context for another agent to resume without reconstructing this session.

Do not edit project files during this handoff unless correcting a factual omission you just discovered. After the tool succeeds, reply with the stored handoff path and nothing ceremonial.

For reference, your prior completion summary was:

${truncate(finalOutput || "(no assistant summary was emitted)", 12_000)}
`;
}

export function recoveryPrompt(session: SessionRecord, message?: string): string {
  return `Resume the Leetcoder delegation \"${session.title}\" from its saved OMP session and current worktree. Inspect the actual repository state before acting; the gateway restarted and no in-flight assumption is trustworthy.

Original objective:
${session.task}

${message ? `New direction from Hermes:\n${message}\n` : "Continue from the last safe point and finish the original objective."}
`;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n…[truncated]`;
}
