import { execa } from "execa";
import { STEP_CANCEL_GRACE_MS } from "@deployx/shared";

/**
 * Steps run in their own process group (POSIX) so cancelling one kills the
 * whole tree — `sh -c "npm test"` would otherwise leave npm/node orphaned
 * and holding the output pipes open. Windows has no process groups.
 */
export const USE_PROCESS_GROUPS = process.platform !== "win32";

// Detached groups don't get the terminal's SIGINT and execa's `cleanup`
// doesn't apply to them, so kill any still running when the runner exits.
const activeGroups = new Set<number>();
let exitHookInstalled = false;

export function trackProcessGroup(pid: number | undefined): () => void {
  if (!USE_PROCESS_GROUPS || pid === undefined) return () => {};

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const groupPid of activeGroups) signalGroup(groupPid, "SIGKILL");
    });
  }

  activeGroups.add(pid);
  return () => {
    activeGroups.delete(pid);
  };
}

/**
 * Runs `handler` once when `signal` aborts. Returns a disposer that
 * detaches the listener.
 */
export function onAbort(
  signal: AbortSignal | undefined,
  handler: () => void,
): () => void {
  if (!signal) return () => {};
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

export interface StepTerminator {
  /** SIGTERM the process group (SIGKILL after a grace period) and remove the container */
  readonly terminate: () => Promise<void>;
  /** Call once the step has exited: cancels the pending SIGKILL escalation */
  readonly dispose: () => void;
}

/**
 * Creates a terminator for a running step. Killing the `docker run` client
 * alone doesn't stop the container, so it is force-removed by name.
 */
export function createStepTerminator(target: {
  readonly pid: number | undefined;
  readonly containerName: string | null;
}): StepTerminator {
  const { pid, containerName } = target;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const terminate = async (): Promise<void> => {
    if (USE_PROCESS_GROUPS && pid !== undefined) {
      signalGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), STEP_CANCEL_GRACE_MS);
    }

    if (containerName) {
      const result = await execa("docker", ["rm", "-f", containerName], { reject: false });
      if (result.exitCode !== 0 && !result.stderr?.includes("No such container")) {
        console.error(`Failed to remove cancelled step container ${containerName}: ${result.stderr}`);
      }
    }
  };

  const dispose = (): void => {
    if (killTimer) clearTimeout(killTimer);
  };

  return { terminate, dispose };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH: the group already exited — nothing to do
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to send ${signal} to step process group ${pid}: ${msg}`);
    }
  }
}
