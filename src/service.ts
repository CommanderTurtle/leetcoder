import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, repoRoot } from "./paths.ts";

export function servicePath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "leetcoder.service");
}

export function installService(start: boolean): void {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun is required");
  const file = servicePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const unit = `[Unit]
Description=Leetcoder Hermes-to-OMP delegation gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${escape(repoRoot())}
ExecStart=${escape(bun)} ${escape(path.join(repoRoot(), "dist", "cli.js"))} serve
Environment=LEETCODER_CONFIG=${escape(configPath())}
Environment=OTEL_SDK_DISABLED=true
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
`;
  writeFileSync(file, unit, { mode: 0o600 });
  systemctl(["--user", "daemon-reload"]);
  systemctl(["--user", "enable", "leetcoder.service"]);
  if (start) systemctl(["--user", "restart", "leetcoder.service"]);
}

export function removeService(): void {
  systemctl(["--user", "disable", "--now", "leetcoder.service"], true);
  if (existsSync(servicePath())) rmSync(servicePath());
  systemctl(["--user", "daemon-reload"], true);
}

export function serviceAction(action: "start" | "stop" | "restart" | "status"): number {
  return systemctl(["--user", action, "leetcoder.service"], action === "status");
}

function systemctl(args: string[], allowFailure = false): number {
  const result = spawnSync("systemctl", args, { stdio: "inherit" });
  if (!allowFailure && result.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed`);
  return result.status ?? 1;
}

function escape(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error("Systemd value cannot contain a newline");
  return value.replace(/%/g, "%%").replace(/ /g, "\\x20");
}
