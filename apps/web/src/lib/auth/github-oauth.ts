import { createClient } from "@/lib/supabase/client";
import { buildAuthCallbackUrl } from "@/lib/safe-redirect";

/**
 * Start the GitHub OAuth flow (browser only). After the callback exchanges
 * the code, the user lands on `next` if it is a safe relative path, else `/`.
 *
 * Note: Supabase's redirect allow-list must accept the callback URL with a
 * query string (e.g. `https://<site>/auth/callback**`).
 */
export async function signInWithGitHub(
  next?: string | null,
): Promise<{ readonly error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: buildAuthCallbackUrl(window.location.origin, next),
      scopes: "repo",
    },
  });
  return error ? { error: error.message } : {};
}
