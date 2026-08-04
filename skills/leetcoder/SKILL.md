---
name: leetcoder
description: Delegate bounded implementation, bug-fix, audit, refactor, test, research, web, or comparison work from Hermes to persistent isolated OMP sessions. Use when parallel coding or a separately steerable specialist session would materially help.
---

# Leetcoder delegation

Leetcoder is a confirmation-gated Hermes MCP. It owns native OMP RPC sessions,
isolated git worktrees, persistent history, steering, and durable Librarian
handoffs.

## Mandatory start flow

1. Call `leetcoder_delegate` with a short title, complete task, the closest
   template, repository, base ref, and relevant files.
2. Read its response. Tell the user:
   - the proposed title and objective;
   - repository and exact base commit;
   - whether uncommitted files are excluded;
   - every currently active Leetcoder session title.
3. Ask for explicit confirmation. Do not infer consent from the original task.
4. Only after a clear yes, call `leetcoder_confirm` with the returned token and
   the literal confirmation value `YES`.

The confirmation token is short-lived and one-use. If it expires or the scope
changes, prepare again.

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

- `leetcoder_list` shows titles and lifecycle state.
- `leetcoder_inspect` shows recent OMP events, git status, output, errors, and
  handoff state.
- `leetcoder_steer` immediately redirects an actively streaming session.
- `leetcoder_follow_up` queues a separate, durable turn. Every queued turn gets
  its own Librarian handoff.
- `leetcoder_resume` reopens a paused, failed, or completed native OMP session.
- `leetcoder_close` preserves its branch and worktree. Prefer graceful close;
  force close explicitly records that the handoff is not guaranteed.

Never claim completion merely because the OMP worker stopped. Completion is
truthful only when `handoffComplete` is true or the failure is reported plainly.
