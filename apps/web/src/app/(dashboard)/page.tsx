import Link from "next/link";
import { TopBar } from "@/components/layout/top-bar";
import { StatCard } from "@/components/dashboard/stat-card";
import { PipelineRunsTable } from "@/components/dashboard/pipeline-runs-table";
import { DeploymentHealthCards } from "@/components/dashboard/deployment-health-cards";
import { requireUserWithOrg } from "@/lib/auth/session";
import { formatDate } from "@/lib/format-date";
import { computeTrend, splitByWindow } from "@/lib/trend";
import { computeUptimePercent, SLA_DEFAULT_WINDOW_HOURS } from "@deployx/shared";

const TREND_WINDOW_DAYS = 7;

export default async function DashboardOverview() {
  const { supabase, user, org } = await requireUserWithOrg();

  const displayName =
    user.user_metadata?.full_name ??
    user.user_metadata?.user_name ??
    "there";

  // Get project IDs for this org
  const { data: orgProjects } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", org.id);

  const projectIds = (orgProjects ?? []).map((p) => p.id);

  // Fetch counts for stats (only if projects exist)
  const { count: totalRuns } = projectIds.length > 0
    ? await supabase
        .from("pipeline_runs")
        .select("id", { count: "exact", head: true })
        .in("project_id", projectIds)
    : { count: 0 };

  const { count: activeDeployments } = projectIds.length > 0
    ? await supabase
        .from("deployments")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .in("project_id", projectIds)
    : { count: 0 };

  // Fetch recent pipeline runs
  const { data: recentRuns } = projectIds.length > 0
    ? await supabase
        .from("pipeline_runs")
        .select("id, status, trigger_type, git_branch, git_sha, duration_ms, created_at, project_id, projects(name), pipeline_definitions(name)")
        .in("project_id", projectIds)
        .order("created_at", { ascending: false })
        .limit(8)
    : { data: [] };

  // Fetch active deployments with health
  const { data: activeDeploymentsList } = projectIds.length > 0
    ? await supabase
        .from("deployments")
        .select("id, status, health_status, strategy, current_revision_id, created_at, project_id, projects(name)")
        .in("project_id", projectIds)
        .order("created_at", { ascending: false })
        .limit(4)
    : { data: [] };

  // ── Current revision image tags + uptime for the health cards ──
  const revisionIds = (activeDeploymentsList ?? [])
    .map((d) => d.current_revision_id as string | null)
    .filter((id): id is string => id != null);

  const { data: revisions } = revisionIds.length > 0
    ? await supabase
        .from("deployment_revisions")
        .select("id, image_tag")
        .in("id", revisionIds)
    : { data: [] };
  const imageTagByRevisionId = new Map(
    (revisions ?? []).map((r) => [r.id as string, r.image_tag as string]),
  );

  const deploymentIds = (activeDeploymentsList ?? []).map((d) => d.id as string);
  const { data: healthChecksForUptime } = deploymentIds.length > 0
    ? await supabase
        .from("health_check_results")
        .select("deployment_id, status, checked_at")
        .in("deployment_id", deploymentIds)
        .order("checked_at", { ascending: false })
        .limit(1000)
    : { data: [] };

  const healthChecksByDeployment = new Map<string, { status: string; checked_at: string }[]>();
  for (const check of healthChecksForUptime ?? []) {
    const depId = check.deployment_id as string;
    const existing = healthChecksByDeployment.get(depId) ?? [];
    existing.push({ status: check.status as string, checked_at: check.checked_at as string });
    healthChecksByDeployment.set(depId, existing);
  }

  // Compute success rate and avg build time from recent runs
  const { data: metricsRuns } = projectIds.length > 0
    ? await supabase
        .from("pipeline_runs")
        .select("status, duration_ms, created_at")
        .in("project_id", projectIds)
        .order("created_at", { ascending: false })
        .limit(500)
    : { data: [] };

  const allMetricsRuns = metricsRuns ?? [];
  const completedRuns = allMetricsRuns.filter(
    (r) => r.status === "success" || r.status === "failed",
  );
  const successfulRuns = allMetricsRuns.filter((r) => r.status === "success");
  const successRate =
    completedRuns.length > 0
      ? `${Math.round((successfulRuns.length / completedRuns.length) * 100)}%`
      : "—";

  const successDurations = successfulRuns
    .filter((r) => r.duration_ms != null)
    .map((r) => r.duration_ms as number);
  const avgBuildTime =
    successDurations.length > 0
      ? `${(successDurations.reduce((a, b) => a + b, 0) / successDurations.length / 1000).toFixed(1)}s`
      : "—";

  // ── Trends: last 7 days vs. the previous 7 days ────────────────
  const runsByWindow = splitByWindow(allMetricsRuns, TREND_WINDOW_DAYS);
  const totalRunsTrend = computeTrend(
    runsByWindow.current.length,
    runsByWindow.previous.length,
  );

  const successRateFor = (runs: readonly { status: string; duration_ms: number | null }[]) => {
    const completed = runs.filter((r) => r.status === "success" || r.status === "failed");
    const successful = runs.filter((r) => r.status === "success");
    return completed.length > 0 ? (successful.length / completed.length) * 100 : 0;
  };
  const successRateTrend = computeTrend(
    successRateFor(runsByWindow.current),
    successRateFor(runsByWindow.previous),
  );

  const avgDurationFor = (runs: readonly { status: string; duration_ms: number | null }[]) => {
    const durations = runs
      .filter((r) => r.status === "success" && r.duration_ms != null)
      .map((r) => r.duration_ms as number);
    return durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  };
  const avgBuildTimeTrend = computeTrend(
    avgDurationFor(runsByWindow.current),
    avgDurationFor(runsByWindow.previous),
  );

  const { data: recentDeploymentsForTrend } = projectIds.length > 0
    ? await supabase
        .from("deployments")
        .select("created_at")
        .in("project_id", projectIds)
        .order("created_at", { ascending: false })
        .limit(500)
    : { data: [] };
  const deploymentsByWindow = splitByWindow(recentDeploymentsForTrend ?? [], TREND_WINDOW_DAYS);
  const activeDeploymentsTrend = computeTrend(
    deploymentsByWindow.current.length,
    deploymentsByWindow.previous.length,
  );

  // Determine greeting based on time
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <>
      <TopBar breadcrumbs={[{ label: "Overview" }]} />
      <div className="px-8 pb-12 pt-4 max-w-[1600px] mx-auto">
        {/* Welcome Header */}
        <section className="mb-10 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-2xl font-bold tracking-tight">
                {greeting}, {displayName}
              </h2>
              <span className="px-2 py-0.5 bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-widest rounded-sm border border-primary/20">
                {org.name}
              </span>
            </div>
            <p className="text-on-surface-variant text-sm">
              System health is{" "}
              <span className="text-tertiary">optimal</span>.{" "}
              {activeDeployments ?? 0} deployment{activeDeployments !== 1 ? "s" : ""} running.
            </p>
          </div>
          <Link
            href="/projects"
            className="bg-primary text-on-primary px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 shadow-lg shadow-primary/10 active:scale-95"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            New Pipeline
          </Link>
        </section>

        {/* Stats Row */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
          <StatCard
            label="Total Pipelines"
            value={String(totalRuns ?? 0)}
            icon="rocket_launch"
            accentColor="primary"
            trend={totalRunsTrend}
          />
          <StatCard
            label="Success Rate"
            value={successRate}
            icon="check_circle"
            accentColor="tertiary"
            trend={successRateTrend}
          />
          <StatCard
            label="Avg Build Time"
            value={avgBuildTime}
            icon="timer"
            accentColor="secondary"
            trend={avgBuildTimeTrend}
          />
          <StatCard
            label="Active Deployments"
            value={String(activeDeployments ?? 0)}
            icon="dynamic_form"
            accentColor="primary-container"
            trend={activeDeploymentsTrend}
          />
        </section>

        {/* Main Content */}
        <div className="flex flex-col lg:flex-row gap-8">
          <div className="lg:w-3/5">
            <PipelineRunsTable
              runs={(recentRuns ?? []).map((run) => ({
                id: run.id,
                name:
                  (run.pipeline_definitions as unknown as { name: string } | null)?.name ??
                  "Pipeline",
                project: (run.projects as unknown as { name: string } | null)?.name ?? "—",
                project_id: run.project_id,
                branch: run.git_branch ?? "default",
                status: run.status as "success" | "failed" | "running" | "queued" | "created" | "cancelled" | "timed_out",
                duration: run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : null,
                triggered_at: formatDate(run.created_at),
              }))}
            />
          </div>
          <div className="lg:w-2/5">
            <DeploymentHealthCards
              deployments={(activeDeploymentsList ?? []).map((d) => {
                const revisionId = d.current_revision_id as string | null;
                const checks = healthChecksByDeployment.get(d.id as string) ?? [];
                const uptimePercent = computeUptimePercent(checks, SLA_DEFAULT_WINDOW_HOURS);
                return {
                  id: d.id,
                  name: (d.projects as unknown as { name: string } | null)?.name ?? "—",
                  project_id: d.project_id,
                  status: d.status as "active" | "deploying" | "rolled_back" | "stopped",
                  health: d.health_status as "healthy" | "degraded" | "unhealthy" | "unknown",
                  image_sha: revisionId ? imageTagByRevisionId.get(revisionId) ?? "—" : "—",
                  uptime: checks.length > 0 ? `${uptimePercent.toFixed(2)}%` : "—",
                };
              })}
            />
          </div>
        </div>
      </div>
    </>
  );
}
