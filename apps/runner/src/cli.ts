#!/usr/bin/env node
import { Command } from "commander";
import { registerCommand } from "./commands/register";
import { startCommand } from "./commands/start";
import { statusCommand } from "./commands/status";
import { unregisterCommand } from "./commands/unregister";

const program = new Command();

program
  .name("deployx-runner")
  .description("DeployX self-hosted CI/CD runner agent")
  .version("0.0.1");

program
  .command("register")
  .description("Register this runner with a DeployX control plane")
  .requiredOption("--token <token>", "Registration token from dashboard")
  .requiredOption("--url <url>", "Control plane URL (e.g., https://deployx.vercel.app)")
  .option("--name <name>", "Runner name", `runner-${Date.now()}`)
  .action(registerCommand);

program
  .command("start")
  .description("Start the runner and begin polling for jobs")
  .action(startCommand);

program
  .command("status")
  .description("Show runner registration status and connectivity")
  .action(statusCommand);

program
  .command("unregister")
  .description("Unregister this runner and remove local config")
  .action(unregisterCommand);

program.parse();
