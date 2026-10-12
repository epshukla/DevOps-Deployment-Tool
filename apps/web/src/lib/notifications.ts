import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationType } from "@deployx/shared";

/**
 * Notification producers. All writes go through the service-role client
 * (callers are route handlers / cron jobs, not end users) and never throw:
 * a failed notification must not fail the pipeline status update that
 * triggered it.
 */

export interface NewNotification {
  readonly org_id: string;
  /** null = broadcast to every member of the org */
  readonly user_id: string | null;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  /** `href` (internal path) makes the notification clickable in the UI. */
  readonly metadata?: Record<string, unknown>;
}

export async function createNotification(
  supabase: SupabaseClient,
  notification: NewNotification,
): Promise<void> {
  const { error } = await supabase.from("notifications").insert({
    org_id: notification.org_id,
    user_id: notification.user_id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    metadata: notification.metadata ?? null,
  });

  if (error) {
    console.error(
      `[notifications] Failed to create ${notification.type} notification for org ${notification.org_id}: ${error.message}`,
    );
  }
}

interface RunContext {
  readonly runId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly orgId: string;
  readonly createdBy: string | null;
  readonly gitBranch: string | null;
  readonly gitSha: string | null;
  readonly triggerType: string | null;
}

/** Load what a run notification needs; null if the run vanished. */
export async function loadRunContext(
  supabase: SupabaseClient,
  runId: string,
): Promise<RunContext | null> {
  const { data } = await supabase
    .from("pipeline_runs")
    .select(
      "id, project_id, created_by, git_branch, git_sha, trigger_type, projects!inner(name, org_id)",
    )
    .eq("id", runId)
    .maybeSingle();

  if (!data) return null;
  const project = data.projects as unknown as { name: string; org_id: string };

  return {
    runId: data.id as string,
    projectId: data.project_id as string,
    projectName: project.name,
    orgId: project.org_id,
    createdBy: (data.created_by as string | null) ?? null,
    gitBranch: (data.git_branch as string | null) ?? null,
    gitSha: (data.git_sha as string | null) ?? null,
    triggerType: (data.trigger_type as string | null) ?? null,
  };
}

const RUN_OUTCOME_TITLE: Readonly<Record<string, string>> = {
  success: "Pipeline succeeded",
  failed: "Pipeline failed",
  timed_out: "Pipeline timed out",
};

export function runHref(ctx: Pick<RunContext, "projectId" | "runId">): string {
  return `/projects/${ctx.projectId}/runs/${ctx.runId}`;
}

function describeRef(ctx: RunContext): string {
  const branch = ctx.gitBranch ?? "default branch";
  const sha = ctx.gitSha ? ` @ ${ctx.gitSha.slice(0, 7)}` : "";
  const trigger = ctx.triggerType ? ` · ${ctx.triggerType}` : "";
  return `${branch}${sha}${trigger}`;
}

/**
 * Tell the person who started a run how it ended. Cancelled runs are not
 * announced — the user who cancelled already knows.
 */
export async function notifyRunFinished(
  supabase: SupabaseClient,
  runId: string,
  status: string,
): Promise<void> {
  const title = RUN_OUTCOME_TITLE[status];
  if (!title) return;

  const ctx = await loadRunContext(supabase, runId);
  if (!ctx) return;

  await createNotification(supabase, {
    org_id: ctx.orgId,
    user_id: ctx.createdBy,
    type: "pipeline_status",
    title: `${title}: ${ctx.projectName}`,
    body: describeRef(ctx),
    metadata: { run_id: ctx.runId, project_id: ctx.projectId, status, href: runHref(ctx) },
  });
}

/** Ask the whole org for a review when a gated task starts waiting. */
export async function notifyApprovalRequested(
  supabase: SupabaseClient,
  runId: string,
  taskName: string,
): Promise<void> {
  const ctx = await loadRunContext(supabase, runId);
  if (!ctx) return;

  await createNotification(supabase, {
    org_id: ctx.orgId,
    user_id: null,
    type: "approval_requested",
    title: `Approval needed: ${ctx.projectName}`,
    body: `Task "${taskName}" is waiting for approval (${describeRef(ctx)})`,
    metadata: {
      run_id: ctx.runId,
      project_id: ctx.projectId,
      task_name: taskName,
      href: runHref(ctx),
    },
  });
}

const DEPLOYMENT_OUTCOME_TITLE: Readonly<Record<string, string>> = {
  active: "Deployment live",
  failed: "Deployment failed",
  rolled_back: "Deployment rolled back",
};

export async function notifyDeploymentStatus(
  supabase: SupabaseClient,
  deploymentId: string,
  status: string,
): Promise<void> {
  const title = DEPLOYMENT_OUTCOME_TITLE[status];
  if (!title) return;

  const { data } = await supabase
    .from("deployments")
    .select("id, project_id, strategy, created_by, projects!inner(name, org_id)")
    .eq("id", deploymentId)
    .maybeSingle();
  if (!data) return;

  const project = data.projects as unknown as { name: string; org_id: string };
  await createNotification(supabase, {
    org_id: project.org_id,
    user_id: (data.created_by as string | null) ?? null,
    type: "deployment_status",
    title: `${title}: ${project.name}`,
    body: `${String(data.strategy).replace("_", "-")} deployment is now ${status.replace("_", " ")}`,
    metadata: {
      deployment_id: deploymentId,
      project_id: data.project_id,
      status,
      href: `/projects/${data.project_id}/deployments/${deploymentId}`,
    },
  });
}
