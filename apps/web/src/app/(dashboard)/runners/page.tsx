import { TopBar } from "@/components/layout/top-bar";
import { requireUserWithOrg } from "@/lib/auth/session";
import { hasMinRole } from "@deployx/shared";
import { getRunnerDisplayStatus } from "@/lib/runner-status";
import { formatDate } from "@/lib/format-date";
import { RegisterRunnerDialog } from "./register-runner-dialog";
import { RunnersTable } from "./runners-table";
import { buildRunnerSystemEvents } from "./system-events";
import type { RunnerMetrics } from "@deployx/shared";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { RunnerUsageCard, type RunnerUsageSample } from "@/components/runners/runner-usage-card";
import { isMetricsFresh, percentOf, summarizeRunnerJobs } from "@/lib/runner-usage";

const USAGE_WINDOW_HOURS = 24;

export default async function RunnersPage() {
  const { supabase, org, role } = await requireUserWithOrg();

  const { data: runners } = await supabase
    .from("runner_registrations")
    .select("id, name, status, current_job_id, last_heartbeat_at, system_info, capabilities, created_at, metrics, metrics_at")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false });

  const { data: auditEvents } = await supabase
    .from("audit_events")
    .select("id, action, resource_type, resource_id, details, created_at")
    .eq("org_id", org.id)
    .in("resource_type", ["runner", "runner_registration"])
    .order("created_at", { ascending: false })
    .limit(15);

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  // Twice the window so jobs that started before it but ran into it count
  const jobsSince = new Date(now.getTime() - 2 * USAGE_WINDOW_HOURS * 3_600_000).toISOString();

  const [{ data: samples }, { data: recentRuns }] = await Promise.all([
    supabase
      .from("runner_metrics")
      .select("runner_id, recorded_at, cpu_percent, memory_used_mb, memory_total_mb")
      .eq("org_id", org.id)
      .gte("recorded_at", hourAgo)
      .order("recorded_at", { ascending: true }),
    supabase
      .from("pipeline_runs")
      .select("runner_id, status, started_at, finished_at, duration_ms, projects!inner(org_id)")
      .eq("projects.org_id", org.id)
      .not("runner_id", "is", null)
      .gte("started_at", jobsSince)
      .order("started_at", { ascending: false })
      .limit(2000),
  ]);

  const historyByRunner = new Map<string, RunnerUsageSample[]>();
  for (const sample of samples ?? []) {
    const list = historyByRunner.get(sample.runner_id) ?? [];
    list.push({
      recorded_at: sample.recorded_at,
      cpu_percent: sample.cpu_percent,
      memory_percent: percentOf(sample.memory_used_mb, sample.memory_total_mb),
    });
    historyByRunner.set(sample.runner_id, list);
  }
  const jobsByRunner = summarizeRunnerJobs(recentRuns ?? [], now, USAGE_WINDOW_HOURS);

  const runnerList = runners ?? [];
  const displayStatuses = runnerList.map((r) =>
    getRunnerDisplayStatus(r.status, r.last_heartbeat_at, now),
  );
  const total = runnerList.length;
  const online = displayStatuses.filter((s) => s === "online").length;
  const busy = displayStatuses.filter((s) => s === "busy").length;
  const offline = displayStatuses.filter((s) => s === "offline").length;

  const canRegister = hasMinRole(role, "admin");
  const systemEvents = buildRunnerSystemEvents(auditEvents ?? [], runnerList, 15);

  return (
    <>
      <TopBar breadcrumbs={[{ label: "Runners" }]} />
      <div className="px-4 py-6 md:px-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <h2 className="font-mono text-xl font-semibold text-on-surface">
              Runners
            </h2>
            <p className="text-on-surface-variant text-sm mt-1">
              Manage and scale your private CI/CD execution fleet.
            </p>
          </div>
          <RegisterRunnerDialog canRegister={canRegister} />
        </div>

        {/* Registration Banner */}
        <section className="mb-10">
          <div className="bg-surface-container rounded-lg p-6 relative overflow-hidden group">
            <div className="absolute right-0 top-0 opacity-5 pointer-events-none">
              <span aria-hidden="true"
                className="material-symbols-outlined text-[120px]"
                style={{
                  fontVariationSettings: "'wght' 100",
                }}
              >
                terminal
              </span>
            </div>
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-4">
                <span className="px-2 py-0.5 bg-tertiary-container text-xs font-bold text-on-tertiary-container rounded-sm">
                  Setup Command
                </span>
                <span className="text-on-surface-variant text-xs font-medium">
                  To register a new runner, click &quot;Register Runner&quot; above to generate a token.
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-4 bg-surface-container-lowest border border-outline-variant/20 rounded p-4 font-mono text-sm">
                  <span className="text-tertiary select-none">$</span>
                  <span className="text-on-surface">
                    pnpm runner register --token {"<TOKEN>"} --url {"<URL>"}
                  </span>
                </div>
                <div className="flex items-center gap-4 bg-surface-container-lowest border border-outline-variant/20 rounded p-4 font-mono text-sm">
                  <span className="text-tertiary select-none">$</span>
                  <span className="text-on-surface">
                    pnpm runner start
                  </span>
                </div>
              </div>
              <p className="text-xs text-on-surface-variant/50 mt-2 ml-1">
                Run from the root of a <code className="font-mono text-primary">DevOps-Deployment-Tool</code> clone after <code className="font-mono text-primary">pnpm install</code> (on Windows, inside WSL2).
              </p>
            </div>
          </div>
        </section>

        {/* Stats Grid */}
        <div className="grid grid-cols-4 gap-6 mb-10">
          <div className="bg-surface-container p-5 rounded-lg border-l-4 border-tertiary/40">
            <p className="text-xs text-on-surface-variant font-bold mb-1">
              Total Fleet
            </p>
            <p className="text-2xl font-semibold text-on-surface">{total}</p>
          </div>
          <div className="bg-surface-container p-5 rounded-lg border-l-4 border-tertiary">
            <p className="text-xs text-on-surface-variant font-bold mb-1">
              Online
            </p>
            <p className="text-2xl font-semibold text-on-surface">{online}</p>
          </div>
          <div className="bg-surface-container p-5 rounded-lg border-l-4 border-primary/60">
            <p className="text-xs text-on-surface-variant font-bold mb-1">
              Busy Jobs
            </p>
            <p className="text-2xl font-semibold text-on-surface">{busy}</p>
          </div>
          <div className="bg-surface-container p-5 rounded-lg border-l-4 border-error/40">
            <p className="text-xs text-on-surface-variant font-bold mb-1">
              Offline
            </p>
            <p className="text-2xl font-semibold text-on-surface">{offline}</p>
          </div>
        </div>

        {/* Resource usage */}
        <section className="mb-10" aria-labelledby="runner-usage-heading">
          <div className="flex items-baseline justify-between mb-4">
            <h3 id="runner-usage-heading" className="text-sm font-semibold text-on-surface">
              Resource usage
            </h3>
            <p className="text-xs text-on-surface-variant">
              Host usage is sampled every 30s · jobs over the last {USAGE_WINDOW_HOURS}h · refreshes automatically
            </p>
          </div>
          <AutoRefresh intervalMs={30_000} />
          {runnerList.length === 0 ? (
            <p className="text-sm text-on-surface-variant">No runners registered yet.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {runnerList.map((r, i) => {
                const fresh = isMetricsFresh(r.metrics_at, now);
                return (
                  <RunnerUsageCard
                    key={r.id}
                    name={r.name}
                    status={displayStatuses[i]}
                    metrics={fresh ? (r.metrics as RunnerMetrics | null) : null}
                    metricsAt={r.metrics_at}
                    history={fresh ? historyByRunner.get(r.id) ?? [] : []}
                    jobs={jobsByRunner.get(r.id) ?? null}
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* Runners Table */}
        <RunnersTable runners={runnerList} currentRole={role} />

        {/* System Events */}
        <div className="mt-10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs uppercase font-bold tracking-widest text-on-surface-variant">
              Recent System Events
            </h3>
          </div>
          <div className="bg-surface-container-lowest rounded p-6 font-mono text-[13px] leading-relaxed border border-outline-variant/10 shadow-inner">
            {systemEvents.length > 0 ? (
              <ul className="space-y-2">
                {systemEvents.map((event) => (
                  <li key={event.id} className="flex items-center gap-3 text-xs">
                    <span aria-hidden="true" className="material-symbols-outlined text-sm text-on-surface-variant/60">
                      {event.icon}
                    </span>
                    <span className="text-on-surface">{event.label}</span>
                    <span className="text-on-surface-variant/40 ml-auto">
                      {formatDate(event.timestamp)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-on-surface-variant/50 text-center text-xs">
                No recent system events
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
