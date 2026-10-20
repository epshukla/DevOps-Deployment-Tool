import type { SupabaseClient } from "@supabase/supabase-js";
import { RUNNER_METRICS_RETENTION_HOURS } from "@deployx/shared";

export interface PruneRunnerMetricsResult {
  readonly deleted: number;
  readonly error?: string;
}

/** Drop runner metric samples older than the retention window. */
export async function pruneRunnerMetrics(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<PruneRunnerMetricsResult> {
  const cutoff = new Date(now.getTime() - RUNNER_METRICS_RETENTION_HOURS * 3_600_000);
  const { data, error } = await supabase
    .from("runner_metrics")
    .delete()
    .lt("recorded_at", cutoff.toISOString())
    .select("id");

  if (error) return { deleted: 0, error: error.message };
  return { deleted: data?.length ?? 0 };
}
