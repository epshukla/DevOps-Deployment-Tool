import { RUNNER_METRICS_INTERVAL_MS } from "@deployx/shared";

export type UsageLevel = "ok" | "warn" | "critical" | "unknown";

/** Colour band for a utilisation percentage. */
export function usageLevel(percent: number | null): UsageLevel {
  if (percent == null) return "unknown";
  if (percent >= 90) return "critical";
  if (percent >= 80) return "warn";
  return "ok";
}

export function percentOf(used: number | null, total: number | null): number | null {
  if (used == null || !total) return null;
  return Math.round((used / total) * 1000) / 10;
}

/** A metrics snapshot older than three sampling intervals is stale. */
export function isMetricsFresh(metricsAt: string | null, now: Date = new Date()): boolean {
  if (!metricsAt) return false;
  return now.getTime() - Date.parse(metricsAt) <= RUNNER_METRICS_INTERVAL_MS * 3;
}

export interface RunnerJobRow {
  readonly runner_id: string | null;
  readonly status: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly duration_ms: number | null;
}

export interface RunnerJobSummary {
  readonly jobs: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly running: number;
  /** Share of the window the runner spent executing jobs */
  readonly busyPercent: number;
  readonly avgDurationMs: number | null;
}

const FAILED = new Set(["failed", "timed_out", "cancelled"]);

/** Per-runner job counts and busy time over the last `windowHours`. */
export function summarizeRunnerJobs(
  runs: readonly RunnerJobRow[],
  now: Date,
  windowHours: number,
): ReadonlyMap<string, RunnerJobSummary> {
  const windowMs = windowHours * 3_600_000;
  const windowStart = now.getTime() - windowMs;
  const acc = new Map<string, { jobs: number; succeeded: number; failed: number; running: number; busyMs: number; durations: number[] }>();

  for (const run of runs) {
    if (!run.runner_id || !run.started_at) continue;
    const start = Date.parse(run.started_at);
    const end = run.finished_at ? Date.parse(run.finished_at) : now.getTime();
    if (end < windowStart) continue;

    const entry = acc.get(run.runner_id) ?? { jobs: 0, succeeded: 0, failed: 0, running: 0, busyMs: 0, durations: [] };
    entry.jobs += 1;
    if (run.status === "success") entry.succeeded += 1;
    else if (FAILED.has(run.status)) entry.failed += 1;
    else if (!run.finished_at) entry.running += 1;
    entry.busyMs += Math.max(0, end - Math.max(start, windowStart));
    if (run.duration_ms != null) entry.durations.push(run.duration_ms);
    acc.set(run.runner_id, entry);
  }

  const result = new Map<string, RunnerJobSummary>();
  for (const [runnerId, e] of acc) {
    result.set(runnerId, {
      jobs: e.jobs,
      succeeded: e.succeeded,
      failed: e.failed,
      running: e.running,
      busyPercent: Math.round((e.busyMs / windowMs) * 1000) / 10,
      avgDurationMs: e.durations.length
        ? Math.round(e.durations.reduce((a, b) => a + b, 0) / e.durations.length)
        : null,
    });
  }
  return result;
}
