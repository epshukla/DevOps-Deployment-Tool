import { loadConfig, deleteConfig, getConfigPath } from "../config";

export async function unregisterCommand(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Runner is not registered. Nothing to do.");
    return;
  }

  console.log(`Unregistering runner "${config.name}" (${config.runner_id})...`);

  deleteConfig();

  console.log(`Config removed: ${getConfigPath()}`);
  console.log("Runner unregistered successfully.");
  console.log("");
  console.log("Note: The runner record still exists on the control plane.");
  console.log("It will show as 'offline' after the heartbeat timeout.");
}
