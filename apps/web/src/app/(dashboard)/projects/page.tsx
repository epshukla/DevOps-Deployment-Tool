import Link from "next/link";

import { TopBar } from "@/components/layout/top-bar";
import { ProjectCard } from "@/components/projects/project-card";
import { requireUserWithOrg } from "@/lib/auth/session";
import { formatDate } from "@/lib/format-date";
import { formatDurationMs, type PipelineRunStatus } from "@deployx/shared";

export default async function ProjectsPage() {
  const { supabase, org } = await requireUserWithOrg();

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, slug, git_repo_url, deploy_target, created_at")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false });

  const projectIds = (projects ?? []).map((p) => p.id as string);

  // Fetch the most recent run and deployment per project in two queries
  // (ordered descending, then reduce to the first occurrence per project).
  const latestRunByProject = new Map<
    string,
    { status: string; duration_ms: number | null; git_sha: string | null }
  >();
  const latestDeployTimeByProject = new Map<string, string>();

  if (projectIds.length > 0) {
    const { data: recentRuns } = await supabase
      .from("pipeline_runs")
      .select("project_id, status, duration_ms, git_sha, created_at")
      .in("project_id", projectIds)
      .order("created_at", { ascending: false })
      .limit(500);

    for (const run of recentRuns ?? []) {
      const projectId = run.project_id as string;
      if (!latestRunByProject.has(projectId)) {
        latestRunByProject.set(projectId, {
          status: run.status as string,
          duration_ms: run.duration_ms as number | null,
          git_sha: run.git_sha as string | null,
        });
      }
    }

    const { data: recentDeployments } = await supabase
      .from("deployments")
      .select("project_id, created_at")
      .in("project_id", projectIds)
      .order("created_at", { ascending: false })
      .limit(500);

    for (const deployment of recentDeployments ?? []) {
      const projectId = deployment.project_id as string;
      if (!latestDeployTimeByProject.has(projectId)) {
        latestDeployTimeByProject.set(projectId, deployment.created_at as string);
      }
    }
  }

  return (
    <>
      <TopBar breadcrumbs={[{ label: "Projects" }]} />
      <main className="p-8 flex-1 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="font-mono text-xl font-semibold text-on-surface">
              Projects
            </h2>
            <p className="text-on-surface-variant text-sm mt-1">
              Manage and monitor your active deployment pipelines.
            </p>
          </div>
          <Link
            href="/projects/new"
            className="flex items-center gap-2 bg-primary-container text-on-primary-container px-4 py-2.5 rounded-md font-semibold text-sm hover:opacity-90 transition-all"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-sm">add</span>
            New Project
          </Link>
        </div>

        {/* Projects Grid */}
        {!projects || projects.length === 0 ? (
          <div className="bg-surface-container rounded-lg p-16 text-center">
            <span aria-hidden="true" className="material-symbols-outlined text-5xl text-on-surface-variant/30 mb-4 block">
              account_tree
            </span>
            <p className="text-sm text-on-surface-variant font-medium">
              No projects yet
            </p>
            <p className="text-xs text-on-surface-variant/60 mt-1 mb-6">
              Create your first project to start building pipelines
            </p>
            <Link
              href="/projects/new"
              className="inline-flex items-center gap-2 bg-primary-container text-on-primary-container px-4 py-2 rounded-md font-semibold text-xs hover:opacity-90 transition-all"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-sm">add</span>
              New Project
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => {
              const latestRun = latestRunByProject.get(project.id);
              const latestDeployTime = latestDeployTimeByProject.get(project.id);
              return (
                <Link key={project.id} href={`/projects/${project.id}`}>
                  <ProjectCard
                    id={project.id}
                    name={project.name}
                    git_repo_url={project.git_repo_url}
                    last_pipeline_status={(latestRun?.status as PipelineRunStatus) ?? null}
                    last_deploy_time={latestDeployTime ? formatDate(latestDeployTime) : null}
                    last_build_duration={
                      latestRun?.duration_ms != null
                        ? formatDurationMs(latestRun.duration_ms)
                        : null
                    }
                    last_commit_sha={latestRun?.git_sha?.slice(0, 7) ?? null}
                  />
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
