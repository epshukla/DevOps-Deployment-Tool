import { notFound } from "next/navigation";
import { requireUserWithOrg } from "@/lib/auth/session";
import { loadRunnerOptions } from "@/lib/runner-options";
import { RunDetailClient } from "./run-detail-client";

interface PageProps {
  readonly params: Promise<{ projectId: string; runId: string }>;
}

export default async function PipelineRunDetailPage({ params }: PageProps) {
  const { projectId, runId } = await params;
  const { supabase, org, role } = await requireUserWithOrg();

  // Fetch the pipeline run
  const { data: run } = await supabase
    .from("pipeline_runs")
    .select("id, status, trigger_type, git_branch, git_sha, duration_ms, created_at, started_at, finished_at, pipeline_definition_id, pipeline_version_id, runner_id, target_runner_id")
    .eq("id", runId)
    .eq("project_id", projectId)
    .single();

  if (!run) notFound();

  // Fetch project name for breadcrumbs
  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .single();

  if (!project) notFound();

  // Fetch pipeline definition name
  const { data: definition } = await supabase
    .from("pipeline_definitions")
    .select("name")
    .eq("id", run.pipeline_definition_id)
    .single();

  // Fetch the pipeline version number this run used
  const { data: version } = run.pipeline_version_id
    ? await supabase
        .from("pipeline_definition_versions")
        .select("version")
        .eq("id", run.pipeline_version_id)
        .single()
    : { data: null };

  // Fetch task runs for this pipeline run
  const { data: taskRuns } = await supabase
    .from("task_runs")
    .select("id, task_name, status, started_at, finished_at, duration_ms, depends_on")
    .eq("pipeline_run_id", runId)
    .order("started_at", { ascending: true, nullsFirst: false });

  // Fetch step runs for all tasks
  const taskRunIds = (taskRuns ?? []).map((t) => t.id);
  const { data: stepRuns } = taskRunIds.length > 0
    ? await supabase
        .from("step_runs")
        .select("id, task_run_id, step_name, status, started_at, finished_at, duration_ms, exit_code")
        .in("task_run_id", taskRunIds)
        .order("started_at", { ascending: true, nullsFirst: false })
    : { data: [] };

  // Fetch recent logs
  const { data: logs } = await supabase
    .from("run_logs")
    .select("id, task_run_id, step_run_id, level, message, timestamp")
    .eq("pipeline_run_id", runId)
    .order("timestamp", { ascending: true })
    .limit(500);

  // ── Artifacts (from Supabase Storage, same path convention the
  //    runner uses to upload: {orgId}/{projectId}/{runId}/{filename}) ──
  const artifactPrefix = `${org.id}/${projectId}/${runId}`;
  const { data: artifactFiles } = await supabase.storage
    .from("build-artifacts")
    .list(artifactPrefix);

  const artifacts = (artifactFiles ?? [])
    .filter((f) => f.id != null) // storage .list() can return folder placeholders
    .map((f) => ({
      name: f.name,
      size: (f.metadata as { size?: number } | null)?.size ?? null,
      created_at: f.created_at ?? new Date().toISOString(),
      path: `${artifactPrefix}/${f.name}`,
    }));

  // ── Approvals: any task_run awaiting approval gets its approval +
  //    votes (with voter display names) fetched for the approval card ──
  const awaitingTaskRuns = (taskRuns ?? []).filter((t) => t.status === "awaiting_approval");
  let approvals: Array<{
    id: string;
    task_run_id: string;
    task_name: string;
    status: string;
    required_approvals: number;
    votes: Array<{
      id: string;
      user_id: string;
      voter_name: string;
      decision: string;
      comment: string | null;
      created_at: string;
    }>;
  }> = [];

  if (awaitingTaskRuns.length > 0) {
    const awaitingTaskRunIds = awaitingTaskRuns.map((t) => t.id as string);
    const { data: approvalRows } = await supabase
      .from("deployment_approvals")
      .select("id, task_run_id, status, required_approvals")
      .in("task_run_id", awaitingTaskRunIds);

    const approvalIds = (approvalRows ?? []).map((a) => a.id as string);
    const { data: voteRows } = approvalIds.length > 0
      ? await supabase
          .from("approval_votes")
          .select("id, approval_id, user_id, decision, comment, created_at")
          .in("approval_id", approvalIds)
          .order("created_at", { ascending: true })
      : { data: [] };

    const voterIds = [...new Set((voteRows ?? []).map((v) => v.user_id as string))];
    const { data: voterProfiles } = voterIds.length > 0
      ? await supabase
          .from("user_profiles")
          .select("id, display_name")
          .in("id", voterIds)
      : { data: [] };
    const voterNameById = new Map(
      (voterProfiles ?? []).map((p) => [p.id as string, p.display_name as string]),
    );

    const taskNameByTaskRunId = new Map(
      (taskRuns ?? []).map((t) => [t.id as string, t.task_name as string]),
    );

    approvals = (approvalRows ?? []).map((a) => ({
      id: a.id as string,
      task_run_id: a.task_run_id as string,
      task_name: taskNameByTaskRunId.get(a.task_run_id as string) ?? "Task",
      status: a.status as string,
      required_approvals: a.required_approvals as number,
      votes: (voteRows ?? [])
        .filter((v) => v.approval_id === a.id)
        .map((v) => ({
          id: v.id as string,
          user_id: v.user_id as string,
          voter_name: voterNameById.get(v.user_id as string) ?? "Unknown",
          decision: v.decision as string,
          comment: v.comment as string | null,
          created_at: v.created_at as string,
        })),
    }));
  }

  return (
    <RunDetailClient
      project={project}
      run={run}
      definitionName={definition?.name ?? "Unknown"}
      pipelineDefinitionId={run.pipeline_definition_id}
      pipelineVersion={version?.version ?? null}
      taskRuns={taskRuns ?? []}
      stepRuns={stepRuns ?? []}
      logs={logs ?? []}
      artifacts={artifacts}
      approvals={approvals}
      currentRole={role}
      runnerNames={Object.fromEntries(
        (await loadRunnerOptions(supabase, org.id)).map((r) => [r.id, r.name]),
      )}
    />
  );
}
