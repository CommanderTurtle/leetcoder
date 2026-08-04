#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LeetcoderClient } from "./client.ts";

const client = new LeetcoderClient();
const server = new McpServer(
  { name: "leetcoder", version: "0.1.0" },
  {
    instructions:
      "Leetcoder delegates bounded work from Hermes to isolated, persistent OMP coding sessions. " +
      "Always call leetcoder_delegate first. It starts nothing: show its active-session list and proposal to the user, " +
      "then call leetcoder_confirm only after an explicit yes. Monitor with list/inspect, steer active work, and close deliberately."
  }
);

server.registerTool(
  "leetcoder_delegate",
  {
    title: "Prepare an OMP delegation",
    description:
      "Prepare—but do not start—a bounded OMP task. Returns the proposed work, all active Leetcoder session titles, and a short-lived confirmation token. You MUST show those details and obtain an explicit user confirmation before calling leetcoder_confirm.",
    inputSchema: {
      title: z.string().min(1).max(120).describe("Short title visible only to the parent Hermes session"),
      task: z.string().min(1).max(50_000).describe("Complete objective, constraints, acceptance criteria, and relevant context"),
      template: z.enum(["implementation", "bugfix", "audit", "refactor", "tests", "research", "web", "comparison"]),
      repository: z.string().optional().describe("Absolute or home-relative local git checkout. Omit for a standalone research workspace."),
      baseRef: z.string().optional().describe("Git commit-ish to isolate; defaults to HEAD. Uncommitted source-checkout changes are intentionally excluded."),
      files: z.array(z.string()).max(200).optional().describe("Explicit files or areas that define the intended scope"),
    },
  },
  async (input) => text(await client.call("/v1/delegate", input))
);

server.registerTool(
  "leetcoder_confirm",
  {
    title: "Confirm and start an OMP delegation",
    description:
      "Start a previously prepared delegation. Call only after the human explicitly confirms the exact proposal. confirmation must be the literal string YES; never infer or manufacture consent.",
    inputSchema: {
      confirmationToken: z.string().uuid(),
      confirmation: z.literal("YES"),
    },
  },
  async ({ confirmationToken, confirmation }) => text(await client.call("/v1/confirm", { token: confirmationToken, confirmation }))
);

server.registerTool(
  "leetcoder_list",
  {
    title: "List Leetcoder sessions",
    description: "List persistent OMP delegations, their human titles, lifecycle states, worktrees, branches, and queued follow-ups.",
    inputSchema: {
      includeClosed: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(100),
    },
  },
  async ({ includeClosed, limit }) => text(await client.call("/v1/list", { includeClosed, limit }))
);

server.registerTool(
  "leetcoder_inspect",
  {
    title: "Inspect a Leetcoder session",
    description: "Inspect one session's task, OMP lifecycle, recent tool/output events, current git status, branch, worktree, errors, and Librarian handoff state.",
    inputSchema: {
      sessionId: z.string().min(1),
      eventLimit: z.number().int().min(1).max(200).default(40),
    },
  },
  async ({ sessionId, eventLimit }) => text(await client.call("/v1/inspect", { sessionId, eventLimit }))
);

server.registerTool(
  "leetcoder_steer",
  {
    title: "Steer active OMP work",
    description: "Inject immediate direction into an actively streaming Leetcoder OMP session. Use follow_up for a separate turn after the current work.",
    inputSchema: {
      sessionId: z.string().min(1),
      message: z.string().min(1).max(20_000),
    },
  },
  async ({ sessionId, message }) => text(await client.call("/v1/steer", { sessionId, message }))
);

server.registerTool(
  "leetcoder_follow_up",
  {
    title: "Queue an OMP follow-up",
    description: "Queue a durable follow-up turn for an existing session. It runs serially after current work and receives its own mandatory Librarian handoff.",
    inputSchema: {
      sessionId: z.string().min(1),
      message: z.string().min(1).max(50_000),
    },
  },
  async ({ sessionId, message }) => text(await client.call("/v1/follow-up", { sessionId, message }))
);

server.registerTool(
  "leetcoder_resume",
  {
    title: "Resume a persisted OMP session",
    description: "Reopen a paused, failed, or completed OMP session from its native saved session and queue a recovery turn against the preserved worktree.",
    inputSchema: {
      sessionId: z.string().min(1),
      message: z.string().max(20_000).optional(),
    },
  },
  async ({ sessionId, message }) => text(await client.call("/v1/resume", { sessionId, ...(message ? { message } : {}) }))
);

server.registerTool(
  "leetcoder_close",
  {
    title: "Close a Leetcoder session",
    description:
      "Close a persistent session while preserving its branch and worktree. Graceful close steers to a safe boundary and requires the Librarian handoff. Force close aborts immediately and records that the handoff is not guaranteed.",
    inputSchema: {
      sessionId: z.string().min(1),
      force: z.boolean().default(false),
    },
  },
  async ({ sessionId, force }) => text(await client.call("/v1/close", { sessionId, force }))
);

await server.connect(new StdioServerTransport());
console.error(`[leetcoder:mcp] connected to ${client.apiUrl}`);

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
