#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { installService } from "../src/service.ts";

type McpConfig = { $schema?: string; mcpServers?: Record<string, unknown>; [key: string]: unknown };

const root = path.resolve(import.meta.dir, "..");
const home = os.homedir();
const bun = requireCommand("bun");
const omp = requireCommand("omp");
const hermes = requireCommand("hermes");
requireCommand("git");

console.log("Building Leetcoder with Bun...");
run(bun, ["install", "--frozen-lockfile"]);
run(bun, ["run", "build"]);

const configDir = path.join(home, ".config", "leetcoder");
const configFile = path.join(configDir, "config.json");
const tokenFile = path.join(configDir, "token");
const dataRoot = path.join(home, ".local", "share", "leetcoder");
mkdirSync(configDir, { recursive: true, mode: 0o700 });
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

if (!existsSync(tokenFile)) writeFileSync(tokenFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
chmodSync(tokenFile, 0o600);
if (!existsSync(configFile)) {
  writeFileSync(configFile, `${JSON.stringify({
    version: 1,
    listen: { host: "127.0.0.1", port: 4749, tokenFile },
    omp: { command: omp, profile: "leetcoder", maxWorkers: 3, idleSeconds: 7200, thinking: "high" },
    paths: { dataRoot },
    confirmation: { ttlMinutes: 15 },
    history: { eventsPerSession: 5000 },
  }, null, 2)}\n`, { mode: 0o600 });
}
chmodSync(configFile, 0o600);

configureOmpProfile();
writeEnv();
installHermesSkill();
registerHermesMcp();
installService(true);

const gateway = spawnSync(hermes, ["gateway", "restart"], { stdio: "inherit" });
if (gateway.status !== 0) console.warn("Hermes gateway restart did not complete. Run `hermes gateway restart` after finishing other gateway configuration.");

console.log(`
Leetcoder is installed.

  Repository:     ${root}
  Config:         ${configFile}
  State:          ${dataRoot}
  OMP profile:    ~/.omp/profiles/leetcoder
  Hermes MCP:     leetcoder
  Service:        leetcoder.service

  Use bun run doctor for a concise lifecycle check. Hermes must call
  leetcoder_delegate with action=prepare before action=confirm; no OMP task
  starts without the agent's explicit second call.
`);

function configureOmpProfile(): void {
  const source = path.join(home, ".omp", "agent");
  const target = path.join(home, ".omp", "profiles", "leetcoder", "agent");
  const sourceConfig = path.join(source, "config.yml");
  const sourceMcp = path.join(source, "mcp.json");
  const sourceModels = path.join(source, "models.yml");
  for (const file of [sourceConfig, sourceMcp, sourceModels]) if (!existsSync(file)) fail(`OMP profile source is missing: ${file}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });

  const parsed = parse(readFileSync(sourceConfig, "utf8")) as unknown;
  if (!isRecord(parsed)) fail(`OMP config is not a mapping: ${sourceConfig}`);
  parsed.advisor = { ...record(parsed.advisor), enabled: true, subagents: false, syncBacklog: "1" };
  parsed.async = { ...record(parsed.async), enabled: false };
  parsed.memory = { ...record(parsed.memory), backend: "off" };
  parsed.task = {
    ...record(parsed.task),
    maxConcurrency: 1,
    maxRecursionDepth: 1,
    isolation: { ...record(record(parsed.task).isolation), mode: "auto" },
    batch: true,
  };
  parsed.exa = { ...record(parsed.exa), enabled: false, enableSearch: false, enableResearcher: false, enableWebsets: false };
  parsed.startup = { ...record(parsed.startup), checkUpdate: false };
  parsed.marketplace = { ...record(parsed.marketplace), autoUpdate: "off" };
  writeFileSync(path.join(target, "config.yml"), stringify(parsed), { mode: 0o600 });

  const mcp = JSON.parse(readFileSync(sourceMcp, "utf8")) as unknown;
  if (!isRecord(mcp)) fail(`OMP MCP config is not a mapping: ${sourceMcp}`);
  const servers = record(mcp.mcpServers);
  if (!servers.librarian) fail("OMP's default MCP configuration must contain Librarian before Leetcoder setup");
  delete servers.leetcoder;
  (mcp as McpConfig).mcpServers = servers;
  writeFileSync(path.join(target, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 });
  copyFileSync(sourceModels, path.join(target, "models.yml"));
  chmodSync(path.join(target, "models.yml"), 0o600);
  copyFileSync(path.join(root, "rules", "advisor.md"), path.join(target, "WATCHDOG.md"));
  chmodSync(path.join(target, "WATCHDOG.md"), 0o600);
}

function writeEnv(): void {
  const content = `LEETCODER_CONFIG=${quote(path.join(home, ".config", "leetcoder", "config.json"))}
LEETCODER_API_URL=http://127.0.0.1:4749
LEETCODER_TOKEN_FILE=${quote(tokenFile)}
OMP_COMMAND=${quote(omp)}
OMP_PROFILE=leetcoder
OTEL_SDK_DISABLED=true
`;
  writeFileSync(path.join(root, ".env"), content, { mode: 0o600 });
}

function installHermesSkill(): void {
  const source = path.join(root, "skills", "leetcoder");
  const target = path.join(home, ".hermes", "skills", "autonomous-ai-agents", "leetcoder");
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  cpSync(source, target, { recursive: true, force: true });
}

function registerHermesMcp(): void {
  const name = "leetcoder";
  const listed = spawnSync(hermes, ["mcp", "list"], { encoding: "utf8" });
  const registry = `${listed.stdout || ""}\n${listed.stderr || ""}`;
  if (new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(registry)) run(hermes, ["mcp", "remove", name], true);
  const args = [
    "mcp", "add", name,
    "--command", bun,
    "--env",
    `LEETCODER_API_URL=http://127.0.0.1:4749`,
    `LEETCODER_TOKEN_FILE=${tokenFile}`,
    "OTEL_SDK_DISABLED=true",
    "--args", path.join(root, "dist", "mcp.js"),
  ];
  const added = spawnSync(hermes, args, {
    cwd: root,
    input: "y\n",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (added.status !== 0) fail(`hermes ${args.join(" ")} failed with exit code ${added.status}`);
  const verified = spawnSync(hermes, ["mcp", "list"], { encoding: "utf8" });
  const output = `${verified.stdout || ""}\n${verified.stderr || ""}`;
  if (verified.status !== 0 || !new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(output)) fail("Hermes did not retain the Leetcoder MCP registration");
}

function requireCommand(name: string): string {
  const command = Bun.which(name);
  if (!command) fail(`${name} is required and was not found on PATH`);
  return command;
}

function run(command: string, args: string[], allowFailure = false): void {
  const result = spawnSync(command, args, { cwd: root, stdio: allowFailure ? "ignore" : "inherit" });
  if (!allowFailure && result.status !== 0) fail(`${path.basename(command)} ${args.join(" ")} failed with exit code ${result.status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function quote(value: string): string {
  return /[\s#"'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function fail(message: string): never {
  console.error(`\nSetup failed: ${message}`);
  process.exit(1);
}
