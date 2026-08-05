---
name: leetcoder
description: Autonomously delegate bounded implementation, bug-fix, audit, refactor, test, research, web, or comparison work from Hermes to persistent worktree-isolated OMP sessions. Use when parallel coding or a separately steerable specialist session would materially help.
---

# Leetcoder delegation

Leetcoder is Hermes' autonomous OMP control pane. It owns persistent OMP root
sessions, isolated git worktrees, steering, Advisor review, automatic recovery,
and durable Librarian handoffs. Each root may elect OMP's native `task`/`hub`
swarm; Leetcoder persists that child hierarchy and incremental transcript state
so it survives Hermes compaction and gateway restarts.

## Mandatory start flow

1. Call `leetcoder_delegate` with `action="prepare"`, a short title, complete
   task, the closest template, repository, base ref, and relevant files.
2. Read its proposed scope and every active session. Decide whether the new
   work duplicates an existing session.
3. If it is distinct and useful, call `leetcoder_delegate` again with
   `action="confirm"` and the returned token. This is internal agent lifecycle
   confirmation: never ask the human to approve it.
4. If it overlaps, use `leetcoder_status` and `leetcoder_steer` on the existing
   session instead.

The token is short-lived and one-use. A second active-session check rejects an
exact duplicate at confirmation time. If the token expires or scope changes,
prepare again.

## Template choice

- `implementation`: build a complete feature or integration.
- `bugfix`: trace and correct a demonstrated defect.
- `audit`: evidence-backed review, optionally with explicitly authorized fixes.
- `refactor`: improve structure while preserving behavior.
- `tests`: focused validation design or repair.
- `research`: primary-source or repository research with actionable findings.
- `web`: Firecrawl discovery or Camofox interactive browsing.
- `comparison`: source-based implementation comparison and recommendation.

## Lifecycle

- `leetcoder_status` with no ID restores awareness of all ongoing/recent work
  after compaction, including nested OMP child identities and states. With an ID
  it adds child progress, incremental transcript excerpts, `agent://` artifacts,
  `history://` transcripts, recent events, and live git status. Every view
  includes the objective, literal current activity, and draft location.
- `leetcoder_steer` immediately redirects an active turn. If the worker is not
  active it durably queues the direction and resumes the native OMP session;
  the root is reminded to reuse a relevant child through `hub` before spawning
  another. Callers never choose between follow-up and resume mechanisms.
- `leetcoder_stop` preserves the branch and worktree. Prefer graceful stop;
  force stop explicitly records that the Librarian handoff is not guaranteed.

The public MCP surface is deliberately only these four tools:
`leetcoder_delegate`, `leetcoder_status`, `leetcoder_steer`, and
`leetcoder_stop`. Do not search for lower-level lifecycle commands.

Never claim completion merely because the OMP worker stopped. Completion is
truthful only when `handoffComplete` is true or the failure is reported plainly.
