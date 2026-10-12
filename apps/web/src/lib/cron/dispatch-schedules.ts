import type { SupabaseClient } from "@supabase/supabase-js";
import { getNextCronRun } from "@deployx/shared";

export interface DispatchResult {
  readonly due: number;
  readonly dispatched: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

interface DueSchedule {
  readonly id: string;
  readonly project_id: string;
  readonly pipeline_definition_id: string;
  readonly cron_expression: string;
  readonly timezone: string | null;
  readonly git_branch: string | null;
  readonly next_run_at: string;
  readonly created_by: string;
}

/**
 * Create a pipeline run for every active schedule whose next_run_at has
 * passed.
 *
 * Each schedule is *claimed* first with a compare-and-swap on next_run_at
 * (UPDATE … WHERE next_run_at = <value we read>). If two cron invocations
 * overlap, only one wins the swap, so a schedule can never fire twice for
 * the same slot.
 */
export async function dispatchDueSchedules(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<DispatchResult> {
  const { data, error } = await supabase
    .from("pipeline_schedules")
    .select(
      "id, project_id, pipeline_definition_id, cron_expression, timezone, git_branch, next_run_at, created_by",
    )
    .eq("is_active", true)
    .lte("next_run_at", now.toISOString());

  if (error) {
    return { due: 0, dispatched: 0, skipped: 0, errors: [`fetch: ${error.message}`] };
  }

  const due = (data ?? []) as DueSchedule[];
  const outcomes = await Promise.all(
    due.map((schedule) => dispatchOne(supabase, schedule, now)),
  );

  return {
    due: due.length,
    dispatched: outcomes.filter((o) => o === "dispatched").length,
    skipped: outcomes.filter((o) => o === "skipped").length,
    errors: outcomes.filter((o): o is string => o !== "dispatched" && o !== "skipped"),
  };
}

async function dispatchOne(
  supabase: SupabaseClient,
  schedule: DueSchedule,
  now: Date,
): Promise<"dispatched" | "skipped" | string> {
  let nextRun: Date;
  try {
    nextRun = getNextCronRun(schedule.cron_expression, now, schedule.timezone ?? "UTC");
  } catch (err) {
    return `Schedule ${schedule.id}: ${err instanceof Error ? err.message : "bad cron"}`;
  }

  // 1. Claim this slot atomically
  const { data: claimed, error: claimError } = await supabase
    .from("pipeline_schedules")
    .update({
      next_run_at: nextRun.toISOString(),
      last_run_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", schedule.id)
    .eq("next_run_at", schedule.next_run_at)
    .select("id");

  if (claimError) {
    return `Schedule ${schedule.id}: claim failed: ${claimError.message}`;
  }
  if (!claimed || claimed.length === 0) {
    return "skipped"; // another invocation already dispatched this slot
  }

  // 2. Resolve the pipeline's current version
  const { data: definition } = await supabase
    .from("pipeline_definitions")
    .select("id, current_version_id")
    .eq("id", schedule.pipeline_definition_id)
    .single();

  if (!definition?.current_version_id) {
    return `Schedule ${schedule.id}: pipeline has no version`;
  }

  // 3. Create the run directly in "queued" (created → queued is the only
  //    transition, and nothing observes the intermediate state)
  const { data: run, error: runError } = await supabase
    .from("pipeline_runs")
    .insert({
      pipeline_definition_id: schedule.pipeline_definition_id,
      pipeline_version_id: definition.current_version_id,
      project_id: schedule.project_id,
      status: "queued",
      trigger_type: "schedule",
      trigger_ref: `schedule:${schedule.id}`,
      git_branch: schedule.git_branch,
      created_by: schedule.created_by,
    })
    .select("id")
    .single();

  if (runError || !run) {
    return `Schedule ${schedule.id}: failed to create run${runError ? `: ${runError.message}` : ""}`;
  }

  await supabase
    .from("pipeline_schedules")
    .update({ last_run_id: run.id })
    .eq("id", schedule.id);

  return "dispatched";
}
