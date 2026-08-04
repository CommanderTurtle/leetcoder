import { readFileSync } from "node:fs";
import { defaultTokenPath, expandHome } from "./paths.ts";
import type { JsonObject } from "./types.ts";

export class LeetcoderClient {
  readonly apiUrl: string;
  private readonly token: string;

  constructor() {
    this.apiUrl = (process.env.LEETCODER_API_URL || "http://127.0.0.1:4749").replace(/\/$/, "");
    const tokenFile = expandHome(process.env.LEETCODER_TOKEN_FILE || defaultTokenPath());
    this.token = readFileSync(tokenFile, "utf8").trim();
    if (this.token.length < 32) throw new Error(`Leetcoder token is missing or invalid: ${tokenFile}`);
  }

  async call(path: string, body: JsonObject = {}): Promise<JsonObject> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: path === "/v1/health" ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      ...(path === "/v1/health" ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as unknown;
    const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `Leetcoder gateway returned HTTP ${response.status}`);
    return value;
  }
}
