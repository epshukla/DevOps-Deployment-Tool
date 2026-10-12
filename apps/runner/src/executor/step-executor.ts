import { execa } from "execa";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { STEP_CANCEL_GRACE_MS } from "@deployx/shared";
import type { LogStreamer } from "../logging/log-streamer";
import {
  USE_PROCESS_GROUPS,
  trackProcessGroup,
  createStepTerminator,
  onAbort,
} from "./step-termination";

export interface StepExecutorOptions {
  /** Shell command to execute */
  readonly command: string;
  /** Working directory (the cloned workspace) */
  readonly cwd: string;
  /** Environment variables merged with process.env */
  readonly env?: Readonly<Record<string, string>>;
  /** Timeout in seconds (0 = no timeout) */
  readonly timeoutSeconds?: number;
  /** Docker image to run the command inside (optional) */
  readonly image?: string;
  /** LogStreamer instance for buffered log upload */
  readonly logStreamer: LogStreamer;
  /** IDs for log association */
  readonly taskRunId?: string;
  readonly stepRunId?: string;
  /** Aborting kills the step (process group + step container) */
  readonly signal?: AbortSignal;
}

export interface StepResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** True if the step was killed (or never started) because `signal` aborted */
  readonly cancelled: boolean;
}

/**
 * Executes a single pipeline step command.
 *
 * - Runs the command via `sh -c` for shell features (pipes, env expansion)
 * - If `image` is set, wraps in `docker run --rm -v cwd:/workspace -w /workspace`
 * - Streams stdout (info) and stderr (warn) line-by-line to LogStreamer
 * - Respects timeout; returns exitCode + timedOut flag
 * - Aborting `signal` kills the step's process tree (and step container)
 *   and the result is flagged `cancelled`
 * - Never throws — callers check the returned exitCode
 */
export async function executeStep(
  options: StepExecutorOptions,
): Promise<StepResult> {
  const {
    command,
    cwd,
    env,
    timeoutSeconds,
    image,
    logStreamer,
    taskRunId,
    stepRunId,
    signal,
  } = options;

  if (image !== undefined && !isValidImageRef(image)) {
    logStreamer.push({
      level: "error",
      message: `Invalid Docker image reference ${JSON.stringify(image)} — refusing to run step`,
      task_run_id: taskRunId,
      step_run_id: stepRunId,
    });
    return { exitCode: 1, timedOut: false, cancelled: false };
  }

  if (signal?.aborted) {
    return { exitCode: 1, timedOut: false, cancelled: true };
  }

  const containerName = image ? `deployx-step-${randomUUID().slice(0, 12)}` : null;
  const resolvedCommand = image && containerName
    ? buildDockerCommand({ image, cwd, command, containerName, user: getHostUser() })
    : command;

  return runShellCommand(resolvedCommand, containerName, options);
}

/**
 * Spawns `sh -c command`, streams its output, and wires cancellation.
 */
async function runShellCommand(
  command: string,
  containerName: string | null,
  options: StepExecutorOptions,
): Promise<StepResult> {
  const { cwd, env, timeoutSeconds, logStreamer, taskRunId, stepRunId, signal } = options;

  // Use the workspace cwd only for non-Docker commands.
  // Docker commands mount the workspace via -v, so cwd is less important
  // but we still set it for consistency.
  const subprocess = execa("sh", ["-c", command], {
    cwd,
    env: { ...process.env, ...env },
    timeout: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
    reject: false,
    cancelSignal: signal,
    forceKillAfterDelay: STEP_CANCEL_GRACE_MS,
    // Own process group so a cancel can kill the whole tree
    detached: USE_PROCESS_GROUPS,
    // Keep stdout and stderr as streams for real-time processing
    stdout: "pipe",
    stderr: "pipe",
  });

  const untrack = trackProcessGroup(subprocess.pid);
  const terminator = createStepTerminator({ pid: subprocess.pid, containerName });
  const detachAbort = onAbort(signal, () => void terminator.terminate());

  // execa's own timeout only signals `sh`; also kill the process group and
  // the step container so a timed-out step can't keep running
  const timeout = armTimeout(timeoutSeconds, () => void terminator.terminate());

  try {
    // Stream stdout and stderr concurrently
    const stdoutDone = streamLines(subprocess.stdout, "info", logStreamer, taskRunId, stepRunId);
    const stderrDone = streamLines(subprocess.stderr, "warn", logStreamer, taskRunId, stepRunId);

    // Wait for both stream processing and the process itself
    const [result] = await Promise.all([subprocess, stdoutDone, stderrDone]);
    const exitCode = result.exitCode ?? 1;

    return {
      exitCode,
      timedOut: result.timedOut || timeout.fired(),
      cancelled: result.isCanceled === true || (signal?.aborted === true && exitCode !== 0),
    };
  } finally {
    timeout.clear();
    detachAbort();
    terminator.dispose();
    untrack();
  }
}

/**
 * Calls `onTimeout` after `seconds` (no-op when unset/0).
 */
function armTimeout(
  seconds: number | undefined,
  onTimeout: () => void,
): { readonly fired: () => boolean; readonly clear: () => void } {
  let fired = false;
  const timer = seconds
    ? setTimeout(() => {
        fired = true;
        onTimeout();
      }, seconds * 1000)
    : null;

  return {
    fired: () => fired,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

// Registry/host, path components, tag and digest characters only — no
// whitespace or shell metacharacters, and no leading "-" (flag injection).
const IMAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
const IMAGE_REF_MAX_LENGTH = 256;

/**
 * Returns true if `image` is a plausible Docker image reference that is
 * safe to interpolate into a shell command.
 */
export function isValidImageRef(image: string): boolean {
  return image.length <= IMAGE_REF_MAX_LENGTH && IMAGE_REF_PATTERN.test(image);
}

export interface DockerCommandOptions {
  readonly image: string;
  readonly cwd: string;
  readonly command: string;
  readonly containerName: string;
  /** "uid:gid" to run as, or null to use the image's default user */
  readonly user: string | null;
}

/**
 * Builds a `docker run` command that executes `command` inside `image`,
 * mounting the workspace at /workspace. Every interpolated value is
 * single-quoted. Running as the invoking user keeps files written into the
 * workspace owned by the runner, so workspace cleanup doesn't hit root-owned files.
 */
export function buildDockerCommand(options: DockerCommandOptions): string {
  const { image, cwd, command, containerName, user } = options;
  // HOME=/tmp: an arbitrary uid has no passwd entry, and tools like npm/pip
  // fail when HOME resolves to an unwritable "/"
  const userArgs = user ? `--user ${user} -e HOME=/tmp ` : "";
  return (
    `docker run --rm --name ${shellQuote(containerName)} ${userArgs}` +
    `-v ${shellQuote(`${cwd}:/workspace`)} -w /workspace ` +
    `${shellQuote(image)} sh -c ${shellQuote(command)}`
  );
}

/**
 * Returns "uid:gid" of the runner process, or null where unsupported (Windows).
 */
function getHostUser(): string | null {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return null;
  }
  return `${process.getuid()}:${process.getgid()}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Reads a Node.js Readable stream line-by-line and pushes each line
 * to the LogStreamer with the given log level.
 *
 * Carries partial lines across chunks to avoid splitting mid-line.
 */
async function streamLines(
  stream: Readable | null,
  level: "info" | "warn",
  logStreamer: LogStreamer,
  taskRunId?: string,
  stepRunId?: string,
): Promise<void> {
  if (!stream) return;

  let partial = "";

  for await (const chunk of stream) {
    const text = partial + String(chunk);
    const lines = text.split("\n");

    // Last element is either empty (line ended with \n) or a partial line
    partial = lines.pop() ?? "";

    for (const line of lines) {
      if (line.length > 0) {
        logStreamer.push({
          level,
          message: line,
          task_run_id: taskRunId,
          step_run_id: stepRunId,
        });
      }
    }
  }

  // Flush any remaining partial line
  if (partial.length > 0) {
    logStreamer.push({
      level,
      message: partial,
      task_run_id: taskRunId,
      step_run_id: stepRunId,
    });
  }
}
