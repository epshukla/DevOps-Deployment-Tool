import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface RunnerConfig {
  readonly runner_id: string;
  readonly token: string;
  readonly control_plane_url: string;
  readonly name: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".deployx");
const CONFIG_FILE = path.join(CONFIG_DIR, "runner.json");

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function loadConfig(): RunnerConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.runner_id === "string" &&
      typeof parsed.token === "string" &&
      typeof parsed.control_plane_url === "string" &&
      typeof parsed.name === "string"
    ) {
      return parsed as RunnerConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: RunnerConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  // Restrict permissions to owner-only
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export function deleteConfig(): void {
  try {
    fs.unlinkSync(CONFIG_FILE);
  } catch {
    // File doesn't exist — that's fine
  }
}
