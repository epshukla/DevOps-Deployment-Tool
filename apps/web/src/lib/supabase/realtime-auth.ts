import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Realtime evaluates RLS with the token a channel joins with. The browser
 * client restores the session from cookies asynchronously, so a channel
 * subscribed straight from useEffect joins with the anon key and every row is
 * silently filtered out (SUBSCRIBED, but no events ever arrive). Await this
 * before subscribing.
 */
export async function authorizeRealtime(supabase: SupabaseClient): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) await supabase.realtime.setAuth(token);
  } catch (err) {
    // Subscribe anyway; at worst the channel behaves as before
    console.warn("[realtime] could not load session for realtime auth:", err);
  }
}
