import * as os from "node:os";
import { loadConfig, saveConfig, getConfigPath } from "../config";
import { RunnerApiClient } from "../api-client";

interface RegisterOptions {
  readonly token: string;
  readonly url: string;
  readonly name: string;
}

export async function registerCommand(options: RegisterOptions): Promise<void> {
  const existing = loadConfig();
  if (existing) {
    console.error(
      `Runner already registered as "${existing.name}" (${existing.runner_id}).`,
    );
    console.error(`Config: ${getConfigPath()}`);
    console.error("Run 'deployx-runner unregister' first to re-register.");
    process.exit(1);
  }

  const systemInfo = {
    os: os.platform(),
    arch: os.arch(),
    version: process.version,
  };

  console.log(`Registering runner "${options.name}" with ${options.url}...`);

  // Create a temporary client just for registration
  const tempClient = new RunnerApiClient({
    runner_id: "",
    token: options.token,
    control_plane_url: options.url,
    name: options.name,
  });

  try {
    const result = await tempClient.register(
      options.token,
      options.name,
      systemInfo,
    );

    saveConfig({
      runner_id: result.runner_id,
      token: options.token,
      control_plane_url: options.url,
      name: options.name,
    });

    console.log("");
    console.log("Runner registered successfully!");
    console.log(`  ID:   ${result.runner_id}`);
    console.log(`  Name: ${options.name}`);
    console.log(`  URL:  ${options.url}`);
    console.log("");
    console.log("Start the runner with: deployx-runner start");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Registration failed: ${message}`);
    process.exit(1);
  }
}
