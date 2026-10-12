import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HEARTBEAT_INTERVAL_MS,
  ORPHANED_RUN_GRACE_MS,
  RUNNER_STALE_HEARTBEAT_MULTIPLIER,
} from "@deployx/shared";
import { notifyRunFinished } from "@/lib/notifications";

/** A runner that hasn't heartbeated for this long is considered dead. */
export const RUNNER_STALE_AFTER_MS =
  HEARTBEAT_INTERVAL_MS * RUNNER_STALE_HEARTBEAT_MULTIPLIER;

export interface ReapResult {
  readonly runnersMarkedOffline: number;
  readonly runsTimedOut: number;
  readonly errors: readonly string[];
}

interface RunningRun {
  readonly id: string;
  readonly runner_id: string | null;
  readonly updated_at: string;
  readonly started_at: string | null;
}

interface RunnerHeartbeat {
  readonly id: string;
  readonly last_heartbeat_at: string | null;
  readonly current_job_id: string | null;
}

function isStale(lastHeartbeatAt: string | null, now: Date, staleAfterMs: number): boolean {
  if (!lastHeartbeatAt) return true;
  return now.getTime() - new Date(lastHeartbeatAt).getTime() > staleAfterMs;
}

/**
 * Decide whether a running pipeline run has been orphaned: its runner is
 * gone (deleted / never claimed) or silent, AND the run itself hasn't been
 * touched for the grace period. The grace period protects runs whose runner
 * blipped for a moment (network hiccup, laptop sleep) but is still working.
 */
export function isRunOrphaned(
  run: RunningRun,
  runner: RunnerHeartbeat | undefined,
  now: Date,
  options: { readonly staleAfterMs: number; readonly graceMs: number },
): boolean {
  const lastActivity = new Date(run.updated_at ?? run.started_at ?? 0).getTime();
  const idleLongEnough = now.getTime() - lastActivity > options.graceMs;
  if (!idleLongEnough) return false;

  if (!run.runner_id || !runner) return true;
  return isStale(runner.last_heartbeat_at, now, options.staleAfterMs + options.graceMs);
}

/**
 * Housekeeping for dead runners:
 * 1. Runners whose heartbeat went stale are flipped to "offline".
 * 2. Runs still "running" on a dead runner become "timed_out"; their
 *    unfinished tasks/steps are cancelled and the runner's job is released.
 *
 * Every write is conditional on the state we read, so this is safe to run
 * concurrently and repeatedly.
 */
export async function reapOrphans(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<ReapResult> {
  const errors: string[] = [];
  const staleCutoff = new Date(now.getTime() - RUNNER_STALE_AFTER_MS).toISOString();

  // 1. Stale runners → offline
  const { data: offline, error: offlineError } = await supabase
    .from("runner_registrations")
    .update({ status: "offline" })
    .in("status", ["online", "busy"])
    .or(`last_heartbeat_at.is.null,last_heartbeat_at.lt.${staleCutoff}`)
    .select("id");
  if (offlineError) errors.push(`runners: ${offlineError.message}`);

  // 2. Orphaned runs → timed_out
  const { data: running, error: runError } = await supabase
    .from("pipeline_runs")
    .select("id, runner_id, updated_at, started_at")
    .eq("status", "running");
  if (runError) {
    return {
      runnersMarkedOffline: offline?.length ?? 0,
      runsTimedOut: 0,
      errors: [...errors, `runs: ${runError.message}`],
    };
  }

  const runs = (running ?? []) as RunningRun[];
  const runnerIds = [...new Set(runs.map((r) => r.runner_id).filter((id): id is string => !!id))];
  const { data: runnerRows } = runnerIds.length
    ? await supabase
        .from("runner_registrations")
        .select("id, last_heartbeat_at, current_job_id")
        .in("id", runnerIds)
    : { data: [] as RunnerHeartbeat[] };
  const runnersById = new Map(
    ((runnerRows ?? []) as RunnerHeartbeat[]).map((r) => [r.id, r]),
  );

  const orphaned = runs.filter((run) =>
    isRunOrphaned(run, run.runner_id ? runnersById.get(run.runner_id) : undefined, now, {
      staleAfterMs: RUNNER_STALE_AFTER_MS,
      graceMs: ORPHANED_RUN_GRACE_MS,
    }),
  );

  let timedOut = 0;
  for (const run of orphaned) {
    const outcome = await timeOutRun(supabase, run, now);
    if (outcome === true) timedOut++;
    else if (typeof outcome === "string") errors.push(outcome);
  }

  return { runnersMarkedOffline: offline?.length ?? 0, runsTimedOut: timedOut, errors };
}

async function timeOutRun(
  supabase: SupabaseClient,
  run: RunningRun,
  now: Date,
): Promise<boolean | string> {
  const finishedAt = now.toISOString();

  const { data: updated, error } = await supabase
    .from("pipeline_runs")
    .update({ status: "timed_out", finished_at: finishedAt, updated_at: finishedAt })
    .eq("id", run.id)
    .eq("status", "running")
    .select("id");

  if (error) return `run ${run.id}: ${error.message}`;
  if (!updated || updated.length === 0) return false; // finished meanwhile

  const { data: tasks } = await supabase
    .from("task_runs")
    .select("id")
    .eq("pipeline_run_id", run.id);
  const taskIds = (tasks ?? []).map((t) => t.id as string);

  await Promise.all([
    supabase
      .from("task_runs")
      .update({ status: "cancelled", finished_at: finishedAt, updated_at: finishedAt })
      .eq("pipeline_run_id", run.id)
      .in("status", ["pending", "running", "awaiting_approval"]),
    taskIds.length
      ? supabase
          .from("step_runs")
          .update({ status: "cancelled", finished_at: finishedAt, updated_at: finishedAt })
          .in("task_run_id", taskIds)
          .in("status", ["pending", "running"])
      : Promise.resolve(),
    supabase.from("run_logs").insert({
      pipeline_run_id: run.id,
      level: "error",
      message:
        "Run timed out: its runner stopped sending heartbeats. Re-run the pipeline once a runner is online.",
      timestamp: finishedAt,
      metadata: { source: "reaper", runner_id: run.runner_id },
    }),
    run.runner_id
      ? supabase
          .from("runner_registrations")
          .update({ current_job_id: null })
          .eq("id", run.runner_id)
          .eq("current_job_id", run.id)
      : Promise.resolve(),
  ]);

  await notifyRunFinished(supabase, run.id, "timed_out");
  return true;
}
