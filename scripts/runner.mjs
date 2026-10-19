#!/usr/bin/env node
/**
 * `pnpm runner …` entry point.
 *
 * apps/runner/dist is build output and not committed, so a fresh clone has no
 * CLI to run. Build the runner (and the workspace packages it depends on) the
 * first time, and again whenever its sources are newer than the build — e.g.
 * after a `git pull` — then hand all arguments to the real CLI.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps", "runner", "dist", "cli.js");
const sourceDirs = ["apps/runner/src", "packages/shared/src", "packages/pipeline-engine/src"];
const isWindows = process.platform === "win32";

function newestMtime(dir) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function needsBuild() {
  if (!existsSync(cli)) return "not built yet";
  const builtAt = statSync(cli).mtimeMs;
  const changed = sourceDirs.some((dir) => newestMtime(join(root, dir)) > builtAt);
  return changed ? "sources changed since the last build" : null;
}

if (isWindows) {
  console.warn(
    "\n[deployx] Native Windows detected. Pipeline steps run through `sh` and mount the\n" +
      "workspace into Docker, which needs a Linux shell. Run the runner inside WSL2\n" +
      "(Ubuntu) with Docker Desktop's WSL integration on — see README → Running a runner.\n",
  );
}

if (!existsSync(join(root, "node_modules"))) {
  console.error("[deployx] Dependencies are missing. Run `pnpm install` in the repo root first.");
  process.exit(1);
}

const reason = needsBuild();
if (reason) {
  console.log(`[deployx] Building the runner (${reason})…`);
  const build = spawnSync("pnpm", ["turbo", "build", "--filter=@deployx/runner..."], {
    cwd: root,
    stdio: "inherit",
    shell: isWindows, // pnpm is pnpm.cmd on Windows
  });
  if (build.status !== 0 || !existsSync(cli)) {
    console.error("[deployx] Runner build failed — see the output above.");
    process.exit(build.status || 1);
  }
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
