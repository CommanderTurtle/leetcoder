import { existsSync, readFileSync } from "node:fs";
import { configPath, defaultTokenPath, expandHome } from "./paths.ts";
import type { LeetcoderConfig, ThinkingLevel } from "./types.ts";

const THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function loadConfig(): LeetcoderConfig {
  const file = configPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error(`Leetcoder config must be a JSON object: ${file}`);
    raw = parsed;
  }
  const listen = object(raw.listen);
  const omp = object(raw.omp);
  const paths = object(raw.paths);
  const confirmation = object(raw.confirmation);
  const history = object(raw.history);
  const thinking = optionalString(process.env.LEETCODER_THINKING || omp.thinking);
  if (thinking && !THINKING.has(thinking as ThinkingLevel)) throw new Error(`Invalid OMP thinking level: ${thinking}`);
  const config: LeetcoderConfig = {
    version: 1,
    listen: {
      host: optionalString(process.env.LEETCODER_HOST || listen.host) || "127.0.0.1",
      port: integer(process.env.LEETCODER_PORT || listen.port, 4749, 1, 65535),
      tokenFile: expandHome(optionalString(process.env.LEETCODER_TOKEN_FILE || listen.tokenFile) || defaultTokenPath()),
    },
    omp: {
      command: expandCommand(optionalString(process.env.OMP_COMMAND || omp.command) || "omp"),
      profile: optionalString(process.env.OMP_PROFILE || omp.profile) || "leetcoder",
      maxWorkers: integer(process.env.LEETCODER_MAX_WORKERS || omp.maxWorkers, 3, 1, 32),
      idleSeconds: integer(process.env.LEETCODER_IDLE_SECONDS || omp.idleSeconds, 7200, 60, 86400),
      ...(optionalString(process.env.OMP_PROVIDER || omp.provider) ? { provider: optionalString(process.env.OMP_PROVIDER || omp.provider) } : {}),
      ...(optionalString(process.env.OMP_MODEL || omp.model) ? { model: optionalString(process.env.OMP_MODEL || omp.model) } : {}),
      ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
    },
    paths: {
      dataRoot: expandHome(optionalString(process.env.LEETCODER_DATA_ROOT || paths.dataRoot) || "~/.local/share/leetcoder"),
    },
    confirmation: {
      ttlMinutes: integer(confirmation.ttlMinutes, 15, 1, 1440),
    },
    history: {
      eventsPerSession: integer(history.eventsPerSession, 5000, 100, 100000),
    },
  };
  if (config.listen.host !== "127.0.0.1" && config.listen.host !== "::1") {
    throw new Error("Leetcoder binds only to loopback; use 127.0.0.1 or ::1");
  }
  return config;
}

function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}; received ${String(value)}`);
  }
  return parsed;
}

function expandCommand(value: string): string {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\") ? expandHome(value) : value;
}
