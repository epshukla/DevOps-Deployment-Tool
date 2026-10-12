import type { RunnerApiClient } from "../api-client";

export type StatusPayload = Parameters<RunnerApiClient["reportStatus"]>[1];

/**
 * Report status to the control plane. Logs errors to stderr but never throws.
 * Returns whether the update was accepted.
 */
export async function reportSafe(
  client: RunnerApiClient,
  runId: string,
  payload: StatusPayload,
): Promise<boolean> {
  try {
    await client.reportStatus(runId, payload);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to report status: ${msg}`);
    return false;
  }
}

/**
 * Marks a task (optionally) and the given steps as cancelled.
 *
 * Cancelling a run in the UI already moves non-terminal task/step runs to
 * `cancelled`, so the control plane is expected to reject most of these
 * updates as invalid transitions. Rejections are summarised in a single
 * warning rather than logged per item.
 */
export async function reportCancelled(
  client: RunnerApiClient,
  runId: string,
  target: {
    readonly taskName: string;
    readonly stepNames: readonly string[];
    readonly includeTask: boolean;
  },
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const payloads: StatusPayload[] = [
    ...target.stepNames.map((stepName): StatusPayload => ({
      scope: "step",
      status: "cancelled",
      task_name: target.taskName,
      step_name: stepName,
      finished_at: finishedAt,
    })),
    ...(target.includeTask
      ? [{ scope: "task", status: "cancelled", task_name: target.taskName, finished_at: finishedAt } as const]
      : []),
  ];

  const results = await Promise.allSettled(
    payloads.map((payload) => client.reportStatus(runId, payload)),
  );
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  if (rejected.length > 0) {
    const first = rejected[0].reason instanceof Error
      ? rejected[0].reason.message
      : String(rejected[0].reason);
    console.warn(
      `[task:${target.taskName}] ${rejected.length}/${payloads.length} cancellation update(s) not applied ` +
        `(likely already cancelled by the control plane): ${first}`,
    );
  }
}
