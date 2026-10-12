import Link from "next/link";
import { TopBar } from "@/components/layout/top-bar";
import { StatCard } from "@/components/dashboard/stat-card";
import { Greeting } from "@/components/dashboard/greeting";
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

  // Every active deployment's health: one source for the stat and the header
  const { data: activeHealthRows } = projectIds.length > 0
    ? await supabase
        .from("deployments")
        .select("health_status")
        .eq("status", "active")
        .in("project_id", projectIds)
    : { data: [] };
  const activeDeployments = (activeHealthRows ?? []).length;

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

  // Real fleet health instead of a hardcoded "optimal"
  const liveDeployments = activeHealthRows ?? [];
  const unhealthyCount = liveDeployments.filter((d) => d.health_status === "unhealthy").length;
  const degradedCount = liveDeployments.filter((d) => d.health_status === "degraded").length;
  const fleetHealth =
    liveDeployments.length === 0
      ? { label: "idle", tone: "text-on-surface-variant" }
      : unhealthyCount > 0
        ? { label: `needs attention (${unhealthyCount} unhealthy)`, tone: "text-error" }
        : degradedCount > 0
          ? { label: `degraded (${degradedCount})`, tone: "text-warning" }
          : { label: "optimal", tone: "text-tertiary" };

  return (
    <>
      <TopBar breadcrumbs={[{ label: "Overview" }]} />
      <div className="px-8 pb-12 pt-4 max-w-[1600px] mx-auto">
        {/* Welcome Header */}
        <section className="mb-10 flex items-end justify-between gap-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary/80 mb-2">
              {org.name} · mission control
            </p>
            <h2 className="text-3xl font-bold tracking-tight">
              <Greeting name={displayName.split(" ")[0] ?? displayName} />
            </h2>
            <p className="text-on-surface-variant text-sm mt-1.5 flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${fleetHealth.tone} ${
                  fleetHealth.label === "optimal" ? "animate-pulse" : ""
                }`}
              />
              Fleet is <span className={fleetHealth.tone}>{fleetHealth.label}</span>
              <span className="text-on-surface-variant/40">·</span>
              {liveDeployments.length} deployment{liveDeployments.length !== 1 ? "s" : ""} live
            </p>
          </div>
          <Link
            href="/projects/new"
            className="bg-primary text-on-primary px-4 py-2.5 text-xs font-bold rounded-md transition-all flex items-center gap-2 shadow-[0_8px_24px_-8px_rgb(255_138_61/0.6)] hover:brightness-110 active:scale-95"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-sm">add</span>
            New Project
          </Link>
        </section>

        {/* Stats Row */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
          <StatCard
            label="Total Pipelines"
            value={String(totalRuns ?? 0)}
            icon="rocket_launch"
            accent="primary"
            trend={totalRunsTrend}
          />
          <StatCard
            label="Success Rate"
            value={successRate}
            icon="check_circle"
            accent="tertiary"
            trend={successRateTrend}
            goodWhen="up"
          />
          <StatCard
            label="Avg Build Time"
            value={avgBuildTime}
            icon="timer"
            accent="secondary"
            trend={avgBuildTimeTrend}
            goodWhen="down"
          />
          <StatCard
            label="Active Deployments"
            value={String(activeDeployments ?? 0)}
            icon="dynamic_form"
            accent="info"
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
