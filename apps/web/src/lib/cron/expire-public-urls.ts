import type { SupabaseClient } from "@supabase/supabase-js";

export interface ExpirePublicUrlsResult {
  readonly cleared: number;
  readonly error?: string;
}

/**
 * Clear temporary public URLs whose expiry has passed. The runner removes
 * the tunnel container itself; this keeps the dashboard from showing a dead
 * link even if that runner is offline.
 */
export async function expirePublicUrls(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<ExpirePublicUrlsResult> {
  const { data, error } = await supabase
    .from("deployments")
    .update({ public_url: null, public_url_expires_at: null })
    .not("public_url", "is", null)
    .lte("public_url_expires_at", now.toISOString())
    .select("id");

  if (error) return { cleared: 0, error: error.message };
  return { cleared: data?.length ?? 0 };
}
