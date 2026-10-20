import { GatedLink } from "@/components/ui/gated-link";
import { TopBar } from "@/components/layout/top-bar";
import { KpiStrip } from "@/components/dashboard/kpi-strip";
import { StatusBadge } from "@/components/ui/status-badge";
import { Greeting } from "@/components/dashboard/greeting";
import { PipelineRunsTable } from "@/components/dashboard/pipeline-runs-table";
import { DeploymentHealthCards } from "@/components/dashboard/deployment-health-cards";
import { requireUserWithOrg } from "@/lib/auth/session";
import { formatDate, formatDurationShort, formatRelative } from "@/lib/format-date";
import { computeTrend, splitByWindow } from "@/lib/trend";
import { computeUptimePercent, hasMinRole, SLA_DEFAULT_WINDOW_HOURS } from "@deployx/shared";

const TREND_WINDOW_DAYS = 7;

export default async function DashboardOverview() {
  const { supabase, user, org, role } = await requireUserWithOrg();
  const canEdit = hasMinRole(role, "developer");

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
        .limit(12)
    : { data: [] };

  // Fetch active deployments with health
  const { data: activeDeploymentsList } = projectIds.length > 0
    ? await supabase
        .from("deployments")
        .select("id, status, health_status, strategy, current_revision_id, public_url, public_url_expires_at, created_at, project_id, projects(name)")
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
  const fleetStatus =
    liveDeployments.length === 0
      ? { status: "idle", label: "No live deployments" }
      : unhealthyCount > 0
        ? { status: "unhealthy", label: `${unhealthyCount} unhealthy` }
        : degradedCount > 0
          ? { status: "degraded", label: `${degradedCount} degraded` }
          : { status: "healthy", label: "All healthy" };

  return (
    <>
      <TopBar breadcrumbs={[{ label: "Overview" }]} />
      <div className="mx-auto max-w-[1400px] space-y-5 px-4 py-6 md:px-6">
        {/* Page header */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-mono text-xl font-semibold">Overview</h1>
            <p className="mt-1 text-[13px] text-on-surface-variant">
              <Greeting name={displayName.split(" ")[0] ?? displayName} /> — here&apos;s{" "}
              {org.name} right now.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-2.5 py-1.5 text-xs text-on-surface-variant">
              Fleet
              <StatusBadge status={fleetStatus.status} label={fleetStatus.label} />
            </span>
            <GatedLink
            allowed={canEdit}
            reason={"You have the viewer role — read-only access"}
              href="/projects/new"
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-on-primary transition-colors hover:bg-primary-container"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">add</span>
              New project
            </GatedLink>
          </div>
        </header>

        {/* KPI strip */}
        <KpiStrip
          items={[
            {
              label: "Runs (all time)",
              value: String(totalRuns ?? 0),
              trend: totalRunsTrend,
              goodWhen: "either",
              hint: "Δ last 7d vs prior 7d",
            },
            {
              label: "Success rate",
              value: successRate,
              trend: successRateTrend,
              goodWhen: "up",
              hint: "Finished runs, last 500",
            },
            {
              label: "Avg build time",
              value: avgBuildTime,
              trend: avgBuildTimeTrend,
              goodWhen: "down",
              hint: "Successful runs",
            },
            {
              label: "Live deployments",
              value: String(activeDeployments ?? 0),
              trend: activeDeploymentsTrend,
              goodWhen: "either",
              hint: "New deploys Δ 7d",
            },
          ]}
        />

        {/* Runs + deployments */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-8">
            <PipelineRunsTable
              runs={(recentRuns ?? []).map((run) => ({
                id: run.id,
                name:
                  (run.pipeline_definitions as unknown as { name: string } | null)?.name ??
                  "Pipeline",
                project: (run.projects as unknown as { name: string } | null)?.name ?? "—",
                project_id: run.project_id,
                branch: run.git_branch ?? "default",
                commit: run.git_sha ? (run.git_sha as string).slice(0, 7) : null,
                trigger: (run.trigger_type as string | null) ?? null,
                status: run.status as string,
                duration: formatDurationShort(run.duration_ms as number | null),
                started: formatRelative(run.created_at),
                startedTitle: formatDate(run.created_at),
              }))}
            />
          </div>
          <div className="min-w-0 xl:col-span-4">
            <DeploymentHealthCards
              deployments={(activeDeploymentsList ?? []).map((d) => {
                const revisionId = d.current_revision_id as string | null;
                const checks = healthChecksByDeployment.get(d.id as string) ?? [];
                const uptimePercent = computeUptimePercent(checks, SLA_DEFAULT_WINDOW_HOURS);
                return {
                  id: d.id as string,
                  name: (d.projects as unknown as { name: string } | null)?.name ?? "—",
                  project_id: d.project_id as string,
                  status: d.status as string,
                  health: d.health_status as string,
                  image: revisionId ? imageTagByRevisionId.get(revisionId) ?? "—" : "—",
                  uptime: checks.length > 0 ? `${uptimePercent.toFixed(2)}%` : "—",
                  publicUrl: (d.public_url as string | null) ?? null,
                  publicUrlExpiresAt: (d.public_url_expires_at as string | null) ?? null,
                };
              })}
            />
          </div>
        </div>
      </div>
    </>
  );
}
