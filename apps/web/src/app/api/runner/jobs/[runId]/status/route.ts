import { NextResponse, after } from "next/server";
import { notifyApprovalRequested, notifyRunFinished } from "@/lib/notifications";
import { RunStatusUpdateSchema } from "@deployx/shared";
import { authenticateRunner, authorizeRunnerForRun } from "@/lib/auth/runner";
import {
  assertPipelineTransition,
  assertTaskTransition,
  assertStepTransition,
  isPipelineTerminal,
  InvalidTransitionError,
} from "@deployx/pipeline-engine";

interface RouteParams {
  readonly params: Promise<{ runId: string }>;
}

/**
 * GET /api/runner/jobs/[runId]/status
 *
 * Returns the current status of a pipeline run.
 * Used by runners to poll for cancellation between task groups.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { runId } = await params;
  const auth = await authenticateRunner(request);
  if (!auth.ok) return auth.response;

  const { runner, supabase } = auth;

  const authz = await authorizeRunnerForRun(supabase, runner, runId, {
    requireClaimedBy: false,
  });
  if (!authz.ok) return authz.response;

  return NextResponse.json({ status: authz.value.status });
}

/**
 * POST /api/runner/jobs/[runId]/status
 *
 * Updates the status of a pipeline run, task run, or step run.
 * Validates state transitions using the pipeline engine state machine.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { runId } = await params;
  const auth = await authenticateRunner(request);
  if (!auth.ok) return auth.response;

  const { runner, supabase } = auth;

  const authz = await authorizeRunnerForRun(supabase, runner, runId, {
    requireClaimedBy: true,
  });
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = RunStatusUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { scope, status, task_name, step_name, error_message, exit_code, started_at, finished_at, git_sha } = parsed.data;

  // The schema has no error column; keep the runner's reason in the run log
  if (error_message) {
    const { error: logError } = await supabase.from("run_logs").insert({
      pipeline_run_id: runId,
      level: "error",
      message: `[${scope}${task_name ? `:${task_name}` : ""}${step_name ? `/${step_name}` : ""}] ${error_message}`,
      timestamp: new Date().toISOString(),
      metadata: { source: "status_report", status },
    });
    if (logError) {
      console.error(`[api/runner/status] Failed to persist error_message for ${runId}: ${logError.message}`);
    }
  }

  try {
    if (scope === "pipeline") {
      return await updatePipelineStatus(supabase, runner, runId, status, started_at, finished_at, git_sha);
    }

    if (scope === "task" && task_name) {
      return await updateTaskStatus(supabase, runId, task_name, status, started_at, finished_at);
    }

    if (scope === "step" && task_name && step_name) {
      return await updateStepStatus(supabase, runId, task_name, step_name, status, exit_code, started_at, finished_at);
    }

    return NextResponse.json(
      { error: "Invalid scope/field combination. Task scope requires task_name, step scope requires task_name + step_name." },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return NextResponse.json(
        { error: err.message },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { error: "Internal error updating status" },
      { status: 500 },
    );
  }
}

async function updatePipelineStatus(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  runner: { readonly id: string },
  runId: string,
  newStatus: string,
  startedAt?: string,
  finishedAt?: string,
  gitSha?: string,
) {
  // Fetch current status
  const { data: run } = await supabase
    .from("pipeline_runs")
    .select("status, git_sha")
    .eq("id", runId)
    .single();

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  assertPipelineTransition(run.status, newStatus as Parameters<typeof assertPipelineTransition>[1]);

  const updates: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (startedAt) updates.started_at = startedAt;
  if (finishedAt) updates.finished_at = finishedAt;
  // Fill in the checked-out commit, but never overwrite the webhook's SHA
  if (gitSha && !run.git_sha) updates.git_sha = gitSha;

  const { error } = await supabase
    .from("pipeline_runs")
    .update(updates)
    .eq("id", runId);

  if (error) {
    return NextResponse.json({ error: "Failed to update run" }, { status: 500 });
  }

  // If terminal, release the runner
  if (isPipelineTerminal(newStatus as Parameters<typeof isPipelineTerminal>[0])) {
    await supabase
      .from("runner_registrations")
      .update({ current_job_id: null, status: "online" })
      .eq("id", runner.id);

    // Don't hold the runner's request open for the notification write
    after(() => notifyRunFinished(supabase, runId, newStatus));
  }

  return NextResponse.json({ updated: true, status: newStatus });
}

async function updateTaskStatus(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  runId: string,
  taskName: string,
  newStatus: string,
  startedAt?: string,
  finishedAt?: string,
) {
  const { data: taskRun } = await supabase
    .from("task_runs")
    .select("id, status")
    .eq("pipeline_run_id", runId)
    .eq("task_name", taskName)
    .single();

  if (!taskRun) {
    return NextResponse.json({ error: `Task "${taskName}" not found` }, { status: 404 });
  }

  assertTaskTransition(taskRun.status, newStatus as Parameters<typeof assertTaskTransition>[1]);

  const updates: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (startedAt) updates.started_at = startedAt;
  if (finishedAt) updates.finished_at = finishedAt;

  const { error } = await supabase
    .from("task_runs")
    .update(updates)
    .eq("id", taskRun.id);

  if (error) {
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
  }

  if (newStatus === "awaiting_approval") {
    after(() => notifyApprovalRequested(supabase, runId, taskName));
  }

  return NextResponse.json({ updated: true, task_name: taskName, status: newStatus });
}

async function updateStepStatus(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  runId: string,
  taskName: string,
  stepName: string,
  newStatus: string,
  exitCode?: number,
  startedAt?: string,
  finishedAt?: string,
) {
  // Find the task_run first, then the step_run
  const { data: taskRun } = await supabase
    .from("task_runs")
    .select("id")
    .eq("pipeline_run_id", runId)
    .eq("task_name", taskName)
    .single();

  if (!taskRun) {
    return NextResponse.json({ error: `Task "${taskName}" not found` }, { status: 404 });
  }

  const { data: stepRun } = await supabase
    .from("step_runs")
    .select("id, status")
    .eq("task_run_id", taskRun.id)
    .eq("step_name", stepName)
    .single();

  if (!stepRun) {
    return NextResponse.json({ error: `Step "${stepName}" not found in task "${taskName}"` }, { status: 404 });
  }

  assertStepTransition(stepRun.status, newStatus as Parameters<typeof assertStepTransition>[1]);

  const updates: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (exitCode !== undefined) updates.exit_code = exitCode;
  if (startedAt) updates.started_at = startedAt;
  if (finishedAt) updates.finished_at = finishedAt;

  const { error } = await supabase
    .from("step_runs")
    .update(updates)
    .eq("id", stepRun.id);

  if (error) {
    return NextResponse.json({ error: "Failed to update step" }, { status: 500 });
  }

  return NextResponse.json({ updated: true, task_name: taskName, step_name: stepName, status: newStatus });
}
