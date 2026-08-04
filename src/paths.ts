import os from "node:os";
import path from "node:path";

export function repoRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export function configPath(): string {
  return expandHome(process.env.LEETCODER_CONFIG || "~/.config/leetcoder/config.json");
}

export function defaultTokenPath(): string {
  return expandHome(process.env.LEETCODER_TOKEN_FILE || "~/.config/leetcoder/token");
}

export function systemPromptPath(): string {
  return path.join(repoRoot(), "rules", "leetcoder.md");
}
