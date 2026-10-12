"use server";

import { revalidatePath } from "next/cache";
import { requireUserWithOrg } from "@/lib/auth/session";
import { hasMinRole } from "@deployx/shared";

interface ActionResult {
  readonly error?: string;
  readonly success?: boolean;
}

interface RerunResult {
  readonly error?: string;
  readonly run_id?: string;
}

const TERMINAL_STATUSES = new Set([
  "success",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Cancel a running pipeline run.
 * Updates the run, all non-terminal tasks, and all non-terminal steps to 'cancelled'.
 */
export async function cancelPipelineRun(
  projectId: string,
  runId: string,
): Promise<ActionResult> {
  const { supabase, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "developer")) {
    return { error: "You don't have permission to cancel runs" };
  }

  // Verify the run exists and belongs to this project
  const { data: run } = await supabase
    .from("pipeline_runs")
    .select("id, status")
    .eq("id", runId)
    .eq("project_id", projectId)
    .single();

  if (!run) {
    return { error: "Run not found" };
  }

  if (TERMINAL_STATUSES.has(run.status)) {
    return { error: `Run is already ${run.status}` };
  }

  const now = new Date().toISOString();

  // Cancel the pipeline run
  const { error: runError } = await supabase
    .from("pipeline_runs")
    .update({
      status: "cancelled",
      finished_at: now,
      updated_at: now,
    })
    .eq("id", runId);

  if (runError) {
    return { error: "Failed to cancel run" };
  }

  // Cancel all non-terminal task runs
  await supabase
    .from("task_runs")
    .update({ status: "cancelled", updated_at: now })
    .eq("pipeline_run_id", runId)
    .not("status", "in", `(${[...TERMINAL_STATUSES].join(",")})`);

  // Cancel all non-terminal step runs (via task_runs join)
  const { data: taskRuns } = await supabase
    .from("task_runs")
    .select("id")
    .eq("pipeline_run_id", runId);

  if (taskRuns && taskRuns.length > 0) {
    const taskRunIds = taskRuns.map((tr: { id: string }) => tr.id);
    await supabase
      .from("step_runs")
      .update({ status: "cancelled", updated_at: now })
      .in("task_run_id", taskRunIds)
      .not("status", "in", `(${[...TERMINAL_STATUSES].join(",")})`);
  }

  // Release the runner if one was assigned
  const { data: updatedRun } = await supabase
    .from("pipeline_runs")
    .select("runner_id")
    .eq("id", runId)
    .single();

  if (updatedRun?.runner_id) {
    await supabase
      .from("runner_registrations")
      .update({ current_job_id: null, status: "online" })
      .eq("id", updatedRun.runner_id);
  }

  revalidatePath(`/projects/${projectId}/runs/${runId}`);
  revalidatePath(`/projects/${projectId}`);

  return { success: true };
}

/**
 * Re-run a terminal pipeline run: creates a brand-new run for the same
 * pipeline definition/version, branch, and commit SHA.
 */
export async function rerunPipelineRun(
  projectId: string,
  runId: string,
): Promise<RerunResult> {
  const { supabase, user, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "developer")) {
    return { error: "You don't have permission to re-run pipelines" };
  }

  const { data: sourceRun } = await supabase
    .from("pipeline_runs")
    .select("id, status, pipeline_definition_id, pipeline_version_id, git_branch, git_sha")
    .eq("id", runId)
    .eq("project_id", projectId)
    .single();

  if (!sourceRun) {
    return { error: "Run not found" };
  }

  if (!TERMINAL_STATUSES.has(sourceRun.status)) {
    return { error: "Run must be finished before it can be re-run" };
  }

  const { data: newRun, error: runError } = await supabase
    .from("pipeline_runs")
    .insert({
      pipeline_definition_id: sourceRun.pipeline_definition_id,
      pipeline_version_id: sourceRun.pipeline_version_id,
      project_id: projectId,
      status: "created",
      trigger_type: "manual",
      git_branch: sourceRun.git_branch,
      git_sha: sourceRun.git_sha,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (runError || !newRun) {
    return { error: "Failed to create re-run" };
  }

  const { error: queueError } = await supabase
    .from("pipeline_runs")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("id", newRun.id);

  if (queueError) {
    return { error: "Failed to queue re-run" };
  }

  revalidatePath(`/projects/${projectId}`);

  return { run_id: newRun.id };
}
