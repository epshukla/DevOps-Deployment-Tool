import { NextResponse } from "next/server";
import { authenticateRunner } from "@/lib/auth/runner";

/**
 * GET /api/runner/jobs
 *
 * Returns the next queued pipeline run for the runner's org.
 * The runner polls this endpoint every RUNNER_POLL_INTERVAL_MS (5s).
 */
export async function GET(request: Request) {
  const auth = await authenticateRunner(request);
  if (!auth.ok) return auth.response;

  const { runner, supabase } = auth;

  // Find the oldest queued pipeline run in the runner's org
  const { data: job, error } = await supabase
    .from("pipeline_runs")
    .select(`
      id,
      project_id,
      pipeline_definition_id,
      pipeline_version_id,
      trigger_type,
      git_branch,
      git_sha,
      created_at,
      pipeline_definition_versions!pipeline_runs_pipeline_version_id_fkey (
        config_json,
        yaml_source
      ),
      projects!pipeline_runs_project_id_fkey (
        org_id,
        name,
        slug,
        git_repo_url,
        default_branch,
        dockerfile_path,
        build_context,
        deploy_target
      )
    `)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: "Failed to query jobs" },
      { status: 500 },
    );
  }

  // Filter by org — ensure the job belongs to the runner's org
  if (!job) {
    return NextResponse.json({ job: null });
  }

  const project = job.projects as unknown as {
    org_id: string;
    name: string;
    slug: string;
    git_repo_url: string;
    default_branch: string;
    dockerfile_path: string;
    build_context: string;
    deploy_target: string;
  } | null;
  if (!project || project.org_id !== runner.org_id) {
    return NextResponse.json({ job: null });
  }

  const version = job.pipeline_definition_versions as unknown as { config_json: Record<string, unknown>; yaml_source: string | null } | null;

  return NextResponse.json({
    job: {
      run_id: job.id,
      project_id: job.project_id,
      project_name: project.name,
      project_slug: project.slug,
      git_repo_url: project.git_repo_url,
      git_branch: job.git_branch ?? project.default_branch,
      git_sha: job.git_sha,
      dockerfile_path: project.dockerfile_path,
      build_context: project.build_context,
      deploy_target: project.deploy_target,
      config_json: version?.config_json ?? null,
    },
  });
}
