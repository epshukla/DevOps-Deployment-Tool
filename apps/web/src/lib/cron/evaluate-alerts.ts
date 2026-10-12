import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ALERT_EVALUATION_WINDOW_HOURS,
  HEALTH_ALERT_WINDOW_MINUTES,
  evaluateAlertCondition,
} from "@deployx/shared";
import { createNotification } from "@/lib/notifications";

export interface AlertEvaluationResult {
  readonly evaluated: number;
  readonly fired: number;
  readonly errors: readonly string[];
}

interface AlertRuleRow {
  readonly id: string;
  readonly org_id: string;
  readonly project_id: string | null;
  readonly name: string;
  readonly metric: string;
  readonly operator: string;
  readonly threshold: number;
  readonly severity: string;
  readonly cooldown_minutes: number;
  readonly last_triggered_at: string | null;
}

const TERMINAL_RUN_STATUSES = ["success", "failed", "timed_out"] as const;

const OPERATOR_SYMBOL: Readonly<Record<string, string>> = {
  gt: ">", lt: "<", gte: "≥", lte: "≤", eq: "=",
};

// ── Pure metric math (unit tested) ─────────────────────────────

/** % of finished runs that succeeded; null when there's nothing to judge. */
export function successRatePercent(
  runs: readonly { readonly status: string }[],
): number | null {
  if (runs.length === 0) return null;
  const ok = runs.filter((r) => r.status === "success").length;
  return (ok / runs.length) * 100;
}

export function averageDurationMs(
  runs: readonly { readonly duration_ms: number | null }[],
): number | null {
  const durations = runs
    .map((r) => r.duration_ms)
    .filter((d): d is number => typeof d === "number");
  if (durations.length === 0) return null;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

export function failureRatePercent(
  checks: readonly { readonly status: string }[],
): number | null {
  if (checks.length === 0) return null;
  const failed = checks.filter((c) => c.status === "fail").length;
  return (failed / checks.length) * 100;
}

export function isInCooldown(
  lastTriggeredAt: string | null,
  cooldownMinutes: number,
  now: Date,
): boolean {
  if (!lastTriggeredAt) return false;
  return now.getTime() - new Date(lastTriggeredAt).getTime() < cooldownMinutes * 60_000;
}

// ── Metric loading ─────────────────────────────────────────────

async function scopedProjectIds(
  supabase: SupabaseClient,
  rule: AlertRuleRow,
): Promise<readonly string[]> {
  if (rule.project_id) return [rule.project_id];
  const { data } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", rule.org_id);
  return (data ?? []).map((p) => p.id as string);
}

async function computeMetric(
  supabase: SupabaseClient,
  rule: AlertRuleRow,
  projectIds: readonly string[],
  now: Date,
): Promise<number | null> {
  if (projectIds.length === 0) return null;
  const runWindowStart = new Date(
    now.getTime() - ALERT_EVALUATION_WINDOW_HOURS * 3_600_000,
  ).toISOString();

  switch (rule.metric) {
    case "success_rate": {
      const { data } = await supabase
        .from("pipeline_runs")
        .select("status")
        .in("project_id", projectIds)
        .in("status", [...TERMINAL_RUN_STATUSES])
        .gte("finished_at", runWindowStart);
      return successRatePercent(data ?? []);
    }
    case "avg_duration_ms": {
      const { data } = await supabase
        .from("pipeline_runs")
        .select("duration_ms")
        .in("project_id", projectIds)
        .eq("status", "success")
        .gte("finished_at", runWindowStart);
      return averageDurationMs(data ?? []);
    }
    case "health_check_failure_rate": {
      const { data: deployments } = await supabase
        .from("deployments")
        .select("id")
        .in("project_id", projectIds)
        .eq("status", "active");
      const ids = (deployments ?? []).map((d) => d.id as string);
      if (ids.length === 0) return null;
      const since = new Date(
        now.getTime() - HEALTH_ALERT_WINDOW_MINUTES * 60_000,
      ).toISOString();
      const { data } = await supabase
        .from("health_check_results")
        .select("status")
        .in("deployment_id", ids)
        .gte("checked_at", since);
      return failureRatePercent(data ?? []);
    }
    case "deployment_health": {
      const { count } = await supabase
        .from("deployments")
        .select("id", { count: "exact", head: true })
        .in("project_id", projectIds)
        .eq("status", "active")
        .eq("health_status", "unhealthy");
      return count ?? 0;
    }
    default:
      return null;
  }
}

function formatMetricValue(metric: string, value: number): string {
  if (metric === "avg_duration_ms") return `${Math.round(value)}ms`;
  if (metric === "deployment_health") return `${value} unhealthy`;
  return `${value.toFixed(1)}%`;
}

// ── Evaluation ─────────────────────────────────────────────────

/**
 * Evaluate every active alert rule. A rule fires when its condition holds
 * and it is outside its cooldown; firing stamps last_triggered_at with a
 * conditional update (so concurrent ticks can't double-notify) and sends an
 * org-wide alert notification.
 */
export async function evaluateAlerts(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<AlertEvaluationResult> {
  const { data, error } = await supabase
    .from("alert_rules")
    .select(
      "id, org_id, project_id, name, metric, operator, threshold, severity, cooldown_minutes, last_triggered_at",
    )
    .eq("is_active", true);

  if (error) return { evaluated: 0, fired: 0, errors: [`fetch: ${error.message}`] };

  const rules = (data ?? []) as AlertRuleRow[];
  const errors: string[] = [];
  let fired = 0;

  for (const rule of rules) {
    if (isInCooldown(rule.last_triggered_at, rule.cooldown_minutes, now)) continue;

    try {
      const projectIds = await scopedProjectIds(supabase, rule);
      const value = await computeMetric(supabase, rule, projectIds, now);
      if (value === null) continue; // no data in the window → nothing to judge
      if (!evaluateAlertCondition(value, rule.operator, Number(rule.threshold))) continue;

      if (await fireRule(supabase, rule, value, now)) fired++;
    } catch (err) {
      errors.push(`rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { evaluated: rules.length, fired, errors };
}

async function fireRule(
  supabase: SupabaseClient,
  rule: AlertRuleRow,
  value: number,
  now: Date,
): Promise<boolean> {
  let claim = supabase
    .from("alert_rules")
    .update({ last_triggered_at: now.toISOString() })
    .eq("id", rule.id);
  claim = rule.last_triggered_at
    ? claim.eq("last_triggered_at", rule.last_triggered_at)
    : claim.is("last_triggered_at", null);

  const { data: claimed } = await claim.select("id");
  if (!claimed || claimed.length === 0) return false;

  await createNotification(supabase, {
    org_id: rule.org_id,
    user_id: null,
    type: "alert_fired",
    title: `[${rule.severity.toUpperCase()}] ${rule.name}`,
    body: `${rule.metric} is ${formatMetricValue(rule.metric, value)} (threshold ${OPERATOR_SYMBOL[rule.operator] ?? rule.operator} ${rule.threshold})`,
    metadata: {
      alert_rule_id: rule.id,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      project_id: rule.project_id,
      href: rule.project_id ? `/projects/${rule.project_id}` : "/alerts",
    },
  });
  return true;
}
