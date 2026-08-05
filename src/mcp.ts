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
      "Leetcoder is Hermes' autonomous control pane for persistent, worktree-isolated OMP sessions. " +
      "Use only its four tools. Prepare with leetcoder_delegate action='prepare'; inspect the returned active sessions yourself, " +
      "then call the same tool with action='confirm' and its token when the work is not a duplicate. Never ask the human to confirm this internal delegation. " +
      "Use leetcoder_status after compaction or whenever ongoing work is uncertain; it always returns objective, current activity, and draft location."
  }
);

server.registerTool(
  "leetcoder_delegate",
  {
    title: "Prepare or confirm an OMP delegation",
    description:
      "Two-stage autonomous delegation. First use action='prepare' with the task: nothing starts, and the result shows every active session plus a one-use token. Check for duplicate work yourself. Then use action='confirm' with only that token. Do not ask the human for confirmation.",
    inputSchema: {
      action: z.enum(["prepare", "confirm"]),
      confirmationToken: z.string().uuid().optional().describe("Required only for action='confirm'; use the token from the immediately preceding prepare response"),
      title: z.string().min(1).max(120).optional().describe("Required for prepare: compact title visible to Hermes"),
      task: z.string().min(1).max(50_000).optional().describe("Required for prepare: complete objective, constraints, acceptance criteria, and context"),
      template: z.enum(["implementation", "bugfix", "audit", "refactor", "tests", "research", "web", "comparison"]).optional(),
      repository: z.string().optional().describe("Absolute or home-relative local git checkout. Omit for a standalone research workspace."),
      baseRef: z.string().optional().describe("Git commit-ish to isolate; defaults to HEAD. Uncommitted source-checkout changes are intentionally excluded."),
      files: z.array(z.string()).max(200).optional().describe("Explicit files or areas that define the intended scope"),
    },
  },
  async (input) => {
    if (input.action === "confirm") {
      if (!input.confirmationToken) throw new Error("action='confirm' requires confirmationToken");
      return text(await client.call("/v1/confirm", { token: input.confirmationToken }));
    }
    if (input.confirmationToken) throw new Error("action='prepare' does not accept confirmationToken");
    if (!input.title || !input.task || !input.template) {
      throw new Error("action='prepare' requires title, task, and template");
    }
    return text(await client.call("/v1/delegate", {
      title: input.title,
      task: input.task,
      template: input.template,
      ...(input.repository ? { repository: input.repository } : {}),
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.files ? { files: input.files } : {}),
    }));
  }
);

server.registerTool(
  "leetcoder_status",
  {
    title: "Status of OMP delegations",
    description:
      "Recover Leetcoder awareness after compaction or monitor work. With no sessionId, lists active/recent sessions. With sessionId, returns detailed events and git status. Every result includes the objective, literal current activity, and draft worktree/directory.",
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      includeClosed: z.boolean().default(false),
      eventLimit: z.number().int().min(1).max(200).default(40),
    },
  },
  async ({ sessionId, includeClosed, eventLimit }) => text(
    sessionId
      ? await client.call("/v1/inspect", { sessionId, eventLimit })
      : await client.call("/v1/list", { includeClosed, limit: 100 })
  )
);

server.registerTool(
  "leetcoder_steer",
  {
    title: "Steer active OMP work",
    description:
      "Give an existing delegation new direction. It steers a live OMP turn immediately; otherwise it durably queues a follow-up and automatically resumes the saved OMP session. The caller never chooses between steer/follow-up/resume plumbing.",
    inputSchema: {
      sessionId: z.string().min(1),
      message: z.string().min(1).max(20_000),
    },
  },
  async ({ sessionId, message }) => text(await client.call("/v1/direction", { sessionId, message }))
);

server.registerTool(
  "leetcoder_stop",
  {
    title: "Stop a Leetcoder session",
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
