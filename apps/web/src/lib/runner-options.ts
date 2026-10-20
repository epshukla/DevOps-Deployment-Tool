import type { SupabaseClient } from "@supabase/supabase-js";
import { getRunnerDisplayStatus, type RunnerDisplayStatus } from "./runner-status";

export interface RunnerOption {
  readonly id: string;
  readonly name: string;
  readonly status: RunnerDisplayStatus;
}

const STATUS_ORDER: Record<RunnerDisplayStatus, number> = { online: 0, busy: 1, offline: 2 };

/** The org's runners for a "run on…" picker: available ones first, then by name. */
export async function loadRunnerOptions(
  supabase: SupabaseClient,
  orgId: string,
  now: Date = new Date(),
): Promise<readonly RunnerOption[]> {
  const { data } = await supabase
    .from("runner_registrations")
    .select("id, name, status, last_heartbeat_at")
    .eq("org_id", orgId);

  return (data ?? [])
    .map((r) => ({
      id: r.id as string,
      name: r.name as string,
      status: getRunnerDisplayStatus(r.status as string, r.last_heartbeat_at as string | null, now),
    }))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
}
