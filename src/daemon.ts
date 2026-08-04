import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { LeetcoderOrchestrator } from "./orchestrator.ts";
import type { JsonObject, LeetcoderConfig, PrepareRequest } from "./types.ts";

export async function serve(config: LeetcoderConfig): Promise<void> {
  const token = readFileSync(config.listen.tokenFile, "utf8").trim();
  if (token.length < 32) throw new Error(`Leetcoder token is missing or too short: ${config.listen.tokenFile}`);
  const orchestrator = new LeetcoderOrchestrator(config);
  const server = Bun.serve({
    hostname: config.listen.host,
    port: config.listen.port,
    async fetch(request) {
      try {
        if (!authorized(request, token)) return json({ error: "unauthorized" }, 401);
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/health") return json(orchestrator.health());
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        const length = Number(request.headers.get("content-length") || 0);
        if (length > 256 * 1024) return json({ error: "request body too large" }, 413);
        const body = await readBody(request);
        switch (url.pathname) {
          case "/v1/delegate":
            return json(orchestrator.prepare(body as unknown as PrepareRequest));
          case "/v1/confirm":
            return json(orchestrator.confirm(string(body.token), string(body.confirmation)));
          case "/v1/list":
            return json(orchestrator.list(boolean(body.includeClosed), integer(body.limit, 100)));
          case "/v1/inspect":
            return json(orchestrator.inspect(string(body.sessionId), integer(body.eventLimit, 40)));
          case "/v1/steer":
            return json(await orchestrator.steer(string(body.sessionId), string(body.message)));
          case "/v1/follow-up":
            return json(orchestrator.followUp(string(body.sessionId), string(body.message)));
          case "/v1/resume":
            return json(orchestrator.resume(string(body.sessionId), optionalString(body.message)));
          case "/v1/close":
            return json(await orchestrator.closeSession(string(body.sessionId), boolean(body.force)));
          default:
            return json({ error: "not found" }, 404);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[leetcoder] ${message}`);
        return json({ error: message }, 400);
      }
    },
  });
  orchestrator.resumeQueuedWork();
  console.error(`[leetcoder] listening on http://${config.listen.host}:${server.port}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.error("[leetcoder] stopping");
    await orchestrator.close();
    await server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise(() => undefined);
}

function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function readBody(request: Request): Promise<JsonObject> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  const value = await request.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be a JSON object");
  return value as JsonObject;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("A required string field is missing");
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function integer(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : fallback;
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
