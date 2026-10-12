import { NextResponse } from "next/server";
import { authenticateRunner, authorizeRunnerForRun } from "@/lib/auth/runner";

interface RouteParams {
  readonly params: Promise<{ runId: string }>;
}

/**
 * GET /api/runner/jobs/[runId]/approvals?task_name=deploy
 *
 * Polled by the runner while an approval-gated task is `awaiting_approval`.
 * Returns `{ status: "pending" | "approved" | "rejected" }`.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { runId } = await params;
  const auth = await authenticateRunner(request);
  if (!auth.ok) return auth.response;

  const { runner, supabase } = auth;

  const authz = await authorizeRunnerForRun(supabase, runner, runId, {
    requireClaimedBy: true,
  });
  if (!authz.ok) return authz.response;

  const taskName = new URL(request.url).searchParams.get("task_name");
  if (!taskName) {
    return NextResponse.json(
      { error: "task_name query parameter is required" },
      { status: 400 },
    );
  }

  const { data: taskRun } = await supabase
    .from("task_runs")
    .select("id")
    .eq("pipeline_run_id", runId)
    .eq("task_name", taskName)
    .maybeSingle();

  if (!taskRun) {
    return NextResponse.json(
      { error: `Task "${taskName}" not found` },
      { status: 404 },
    );
  }

  const { data: approval, error } = await supabase
    .from("deployment_approvals")
    .select("status")
    .eq("task_run_id", taskRun.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(
      `[api/runner/approvals] Failed to read approval for ${runId}/${taskName}: ${error.message}`,
    );
    return NextResponse.json(
      { error: "Failed to read approval" },
      { status: 500 },
    );
  }

  if (!approval) {
    // Claim creates the approval; a missing row means the task isn't gated
    return NextResponse.json(
      { error: `Task "${taskName}" does not require approval` },
      { status: 404 },
    );
  }

  return NextResponse.json({ status: approval.status });
}
