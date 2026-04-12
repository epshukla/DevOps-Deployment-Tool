import { loadConfig, getConfigPath } from "../config";
import { RunnerApiClient } from "../api-client";

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Runner is not registered.");
    console.log(`Config path: ${getConfigPath()}`);
    console.log("");
    console.log("Register with: deployx-runner register --token <TOKEN> --url <URL>");
    return;
  }

  console.log("Runner Configuration:");
  console.log(`  ID:             ${config.runner_id}`);
  console.log(`  Name:           ${config.name}`);
  console.log(`  Control Plane:  ${config.control_plane_url}`);
  console.log(`  Config:         ${getConfigPath()}`);
  console.log("");

  // Test connectivity
  console.log("Testing connectivity...");
  const client = new RunnerApiClient(config);
  try {
    await client.heartbeat();
    console.log("  Connection: OK");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.log(`  Connection: FAILED — ${msg}`);
  }
}
