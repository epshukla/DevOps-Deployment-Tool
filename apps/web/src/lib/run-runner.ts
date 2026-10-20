export interface RunRunnerFields {
  readonly runner_id: string | null;
  readonly target_runner_id: string | null;
  readonly status: string;
}

export interface RunRunnerDescription {
  readonly label: string;
  /** assigned: a runner has (or had) the run; waiting: still queued; none: never ran */
  readonly state: "assigned" | "waiting" | "none";
}

const WAITING_STATUSES = new Set(["created", "queued"]);

/** Which runner is running (or will run) a pipeline run, for display. */
export function describeRunRunner(
  run: RunRunnerFields,
  runnerNames: Readonly<Record<string, string>>,
): RunRunnerDescription {
  if (run.runner_id) {
    return { label: runnerNames[run.runner_id] ?? "Removed runner", state: "assigned" };
  }
  if (WAITING_STATUSES.has(run.status)) {
    if (run.target_runner_id) {
      const name = runnerNames[run.target_runner_id] ?? "a removed runner";
      return { label: `Waiting for ${name}`, state: "waiting" };
    }
    return { label: "Any available runner", state: "waiting" };
  }
  return { label: "—", state: "none" };
}
