import { APPROVAL_POLL_INTERVAL_MS } from "@deployx/shared";
import type { RunnerApiClient } from "../api-client";
import type { LogStreamer } from "../logging/log-streamer";

export type ApprovalOutcome = "approved" | "rejected" | "cancelled";

export interface WaitForApprovalOptions {
  readonly client: RunnerApiClient;
  readonly runId: string;
  readonly taskName: string;
  /** Aborts the wait (run cancelled) */
  readonly signal: AbortSignal;
  readonly logStreamer: LogStreamer;
  readonly taskRunId?: string;
  readonly intervalMs?: number;
}

/**
 * Polls the control plane until a reviewer approves or rejects the task,
 * or the run is cancelled. Transient poll errors are logged and retried.
 */
export async function waitForApproval(
  options: WaitForApprovalOptions,
): Promise<ApprovalOutcome> {
  const { client, runId, taskName, signal, logStreamer, taskRunId } = options;
  const intervalMs = options.intervalMs ?? APPROVAL_POLL_INTERVAL_MS;

  while (!signal.aborted) {
    try {
      const { status } = await client.getApprovalStatus(runId, taskName);
      if (status === "approved" || status === "rejected") return status;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logStreamer.push({
        level: "warn",
        message: `[task:${taskName}] Approval status check failed: ${msg} — retrying`,
        task_run_id: taskRunId,
      });
    }

    await sleepUnlessAborted(intervalMs, signal);
  }

  return "cancelled";
}

/**
 * Sleeps for `ms`, resolving early if `signal` aborts.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
