import type { SupabaseClient } from "@supabase/supabase-js";

export interface SettleResult {
  readonly stopped: number;
  /** The previous deployment put back to active, if any. */
  readonly restored: string | null;
  readonly error?: string;
}

const NOTHING: SettleResult = { stopped: 0, restored: null };

/**
 * A new deployment marks the project's active one "draining" before it takes
 * traffic. Once the new deployment's outcome is known, settle the old one:
 *
 * - new one active: the deployer has removed the old container, so the
 *   draining rows are stopped (and lose their public URL).
 * - new one failed / rolled back: the deployer never cut over, so the most
 *   recent draining deployment is still serving and goes back to active.
 */
export async function settlePreviousDeployments(
  supabase: SupabaseClient,
  projectId: string,
  currentDeploymentId: string,
  newStatus: string,
): Promise<SettleResult> {
  const now = new Date().toISOString();

  if (newStatus === "active") {
    const { data, error } = await supabase
      .from("deployments")
      .update({ status: "stopped", public_url: null, public_url_expires_at: null, updated_at: now })
      .eq("project_id", projectId)
      .eq("status", "draining")
      .neq("id", currentDeploymentId)
      .select("id");
    if (error) return { ...NOTHING, error: error.message };
    return { stopped: data?.length ?? 0, restored: null };
  }

  if (newStatus === "failed" || newStatus === "rolled_back") {
    const { data: previous, error: lookupError } = await supabase
      .from("deployments")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "draining")
      .neq("id", currentDeploymentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lookupError) return { ...NOTHING, error: lookupError.message };
    if (!previous) return NOTHING;

    const { error } = await supabase
      .from("deployments")
      .update({ status: "active", updated_at: now })
      .eq("id", previous.id);
    if (error) return { ...NOTHING, error: error.message };
    return { stopped: 0, restored: previous.id as string };
  }

  return NOTHING;
}
