import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProfileSummary {
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly github_username: string | null;
}

/**
 * Look up user profiles by id.
 *
 * user_profiles has no foreign key from org_memberships / audit_events /
 * approval_votes (all reference auth.users), so PostgREST can't embed it —
 * `select("..., user_profiles(...)")` fails with PGRST200 and the whole
 * query returns nothing. Fetch profiles separately and join in memory.
 */
export async function loadProfiles(
  supabase: SupabaseClient,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, ProfileSummary>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase
    .from("user_profiles")
    .select("id, display_name, avatar_url, github_username")
    .in("id", unique);

  if (error) {
    console.error(`[profiles] Failed to load ${unique.length} profile(s): ${error.message}`);
    return new Map();
  }

  return new Map(
    (data ?? []).map((p) => [
      p.id as string,
      {
        display_name: (p.display_name as string | null) ?? "Unknown",
        avatar_url: (p.avatar_url as string | null) ?? null,
        github_username: (p.github_username as string | null) ?? null,
      },
    ]),
  );
}
