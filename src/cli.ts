#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { LeetcoderClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { serve } from "./daemon.ts";
import { configPath, systemPromptPath } from "./paths.ts";
import { installService, removeService, serviceAction } from "./service.ts";

const command = process.argv[2] || "help";

switch (command) {
  case "serve":
    await serve(loadConfig());
    break;
  case "doctor":
    await doctor();
    break;
  case "health":
    console.log(JSON.stringify(await new LeetcoderClient().call("/v1/health"), null, 2));
    break;
  case "sessions":
    console.log(JSON.stringify(await new LeetcoderClient().call("/v1/list", { includeClosed: process.argv.includes("--all"), limit: 200 }), null, 2));
    break;
  case "service": {
    const action = process.argv[3];
    if (action === "install") installService(true);
    else if (action === "remove") removeService();
    else if (action === "start" || action === "stop" || action === "restart" || action === "status") process.exitCode = serviceAction(action);
    else throw new Error("Usage: leetcoder service install|remove|start|stop|restart|status");
    break;
  }
  default:
    console.log(`Leetcoder — Hermes delegation to persistent OMP sessions

Usage:
  leetcoder serve
  leetcoder doctor
  leetcoder health
  leetcoder sessions [--all]
  leetcoder service install|remove|start|stop|restart|status
`);
}

async function doctor(): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  for (const name of ["bun", "omp", "hermes", "git"]) {
    const location = Bun.which(name);
    checks.push([name, Boolean(location), location || "not found"]);
  }
  checks.push(["config", existsSync(configPath()), configPath()]);
  checks.push(["system prompt", existsSync(systemPromptPath()), systemPromptPath()]);
  try {
    const config = loadConfig();
    checks.push(["token", existsSync(config.listen.tokenFile) && readFileSync(config.listen.tokenFile, "utf8").trim().length >= 32, config.listen.tokenFile]);
    const profile = `${process.env.HOME}/.omp/profiles/${config.omp.profile}/agent/mcp.json`;
    checks.push(["OMP profile MCP", existsSync(profile), profile]);
  } catch (error) {
    checks.push(["configuration", false, error instanceof Error ? error.message : String(error)]);
  }
  try {
    const health = await new LeetcoderClient().call("/v1/health");
    checks.push(["gateway", health.ok === true, JSON.stringify(health)]);
  } catch (error) {
    checks.push(["gateway", false, error instanceof Error ? error.message : String(error)]);
  }
  const mcp = spawnSync(Bun.which("hermes") || "hermes", ["mcp", "list"], { encoding: "utf8" });
  const registry = `${mcp.stdout || ""}\n${mcp.stderr || ""}`;
  checks.push(["Hermes MCP", mcp.status === 0 && /(^|\s)leetcoder(\s|$)/m.test(registry), "hermes mcp list"]);
  for (const [name, ok, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}
