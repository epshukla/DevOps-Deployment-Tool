"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import type { RunnerMetrics } from "@deployx/shared";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDurationShort, formatRelative, formatTime } from "@/lib/format-date";
import { percentOf, usageLevel, type RunnerJobSummary, type UsageLevel } from "@/lib/runner-usage";
import type { RunnerDisplayStatus } from "@/lib/runner-status";

export interface RunnerUsageSample {
  readonly recorded_at: string;
  readonly cpu_percent: number | null;
  readonly memory_percent: number | null;
}

export interface RunnerUsageCardProps {
  readonly name: string;
  readonly status: RunnerDisplayStatus;
  /** null when the runner never reported metrics or the snapshot is stale */
  readonly metrics: RunnerMetrics | null;
  readonly metricsAt: string | null;
  readonly history: readonly RunnerUsageSample[];
  readonly jobs: RunnerJobSummary | null;
}

const BAR_TONE: Record<UsageLevel, string> = {
  ok: "bg-tertiary",
  warn: "bg-warning",
  critical: "bg-error",
  unknown: "bg-outline",
};

const TEXT_TONE: Record<UsageLevel, string> = {
  ok: "text-on-surface",
  warn: "text-warning",
  critical: "text-error",
  unknown: "text-on-surface-variant",
};

function UsageBar({
  label,
  percent,
  detail,
}: {
  readonly label: string;
  readonly percent: number | null;
  readonly detail: string;
}) {
  const level = usageLevel(percent);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-on-surface-variant">{label}</span>
        <span className={`font-mono ${TEXT_TONE[level]}`}>
          {percent == null ? "—" : `${percent}%`}
          <span className="text-on-surface-variant"> · {detail}</span>
        </span>
      </div>
      <div
        className="h-1.5 rounded-full bg-surface-container-highest overflow-hidden"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div className={`h-full rounded-full ${BAR_TONE[level]}`} style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      </div>
    </div>
  );
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export function RunnerUsageCard({ name, status, metrics, metricsAt, history, jobs }: RunnerUsageCardProps) {
  const memPct = metrics ? percentOf(metrics.memory_used_mb, metrics.memory_total_mb) : null;
  const diskPct = metrics ? percentOf(metrics.disk_used_gb, metrics.disk_total_gb) : null;

  return (
    <article className="bg-surface-container-low border border-outline-variant rounded-lg p-4 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-mono text-sm font-semibold text-on-surface truncate">{name}</h4>
          <p className="text-xs text-on-surface-variant">
            {metricsAt ? `Updated ${formatRelative(metricsAt)}` : "No usage reported yet"}
          </p>
        </div>
        <StatusBadge status={status} />
      </header>

      {metrics ? (
        <>
          <div className="space-y-3">
            <UsageBar
              label="CPU"
              percent={metrics.cpu_percent}
              detail={`${metrics.cpu_count} cores · load ${metrics.load_1m}`}
            />
            <UsageBar
              label="Memory"
              percent={memPct}
              detail={`${gb(metrics.memory_used_mb)} / ${gb(metrics.memory_total_mb)}`}
            />
            <UsageBar
              label="Disk"
              percent={diskPct}
              detail={
                metrics.disk_used_gb != null && metrics.disk_total_gb != null
                  ? `${metrics.disk_used_gb} / ${metrics.disk_total_gb} GB`
                  : "unknown"
              }
            />
          </div>

          {history.length > 1 && (
            <div>
              <p className="text-xs text-on-surface-variant mb-1">
                Last hour · <span className="text-tertiary">CPU</span> · <span className="text-info">Memory</span>
              </p>
              <ResponsiveContainer width="100%" height={56}>
                <LineChart data={[...history]} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
                  <YAxis domain={[0, 100]} hide />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--color-surface-container, #131c2e)",
                      border: "1px solid var(--color-outline-variant, #1e293b)",
                      borderRadius: "6px",
                      fontSize: "11px",
                      color: "var(--color-on-surface, #f1f5f9)",
                    }}
                    labelFormatter={(_, payload) =>
                      payload?.[0] ? formatTime(String(payload[0].payload.recorded_at)) : ""
                    }
                    formatter={(value, key) => [`${value}%`, key === "cpu_percent" ? "CPU" : "Memory"]}
                  />
                  <Line type="monotone" dataKey="cpu_percent" stroke="var(--color-tertiary, #22c55e)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="memory_percent" stroke="var(--color-info, #60a5fa)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          <dl className="grid grid-cols-3 gap-2 text-xs border-t border-outline-variant pt-3">
            <div>
              <dt className="text-on-surface-variant">DeployX containers</dt>
              <dd className="font-mono text-on-surface">{metrics.containers_running}</dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Their CPU</dt>
              <dd className="font-mono text-on-surface">
                {metrics.docker_cpu_percent == null ? "—" : `${metrics.docker_cpu_percent}%`}
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant">Their memory</dt>
              <dd className="font-mono text-on-surface">
                {metrics.docker_memory_mb == null ? "—" : `${Math.round(metrics.docker_memory_mb)} MB`}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="text-xs text-on-surface-variant">
          {status === "offline"
            ? "Offline — usage appears when the runner is running."
            : "This runner doesn't report usage yet. Update it (git pull) and restart it."}
        </p>
      )}

      <dl className="grid grid-cols-3 gap-2 text-xs border-t border-outline-variant pt-3">
        <div>
          <dt className="text-on-surface-variant">Jobs (24h)</dt>
          <dd className="font-mono text-on-surface">
            {jobs ? `${jobs.jobs}${jobs.running ? ` · ${jobs.running} running` : ""}` : "0"}
          </dd>
        </div>
        <div>
          <dt className="text-on-surface-variant">Busy (24h)</dt>
          <dd className="font-mono text-on-surface">{jobs ? `${jobs.busyPercent}%` : "0%"}</dd>
        </div>
        <div>
          <dt className="text-on-surface-variant">Success · avg</dt>
          <dd className="font-mono text-on-surface">
            {jobs && jobs.jobs > 0
              ? `${jobs.succeeded}/${jobs.jobs - jobs.running} · ${formatDurationShort(jobs.avgDurationMs)}`
              : "—"}
          </dd>
        </div>
      </dl>
    </article>
  );
}
