import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Notification fan-out (publish/subscribe, like SNS → subscribers): every
 * notification is also POSTed to the org's webhook. The body works for Slack
 * incoming webhooks (`text`), Discord (`content`) and generic JSON receivers.
 */

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/** https only, and never an obviously internal host (basic SSRF guard). */
export function isSafeWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return !PRIVATE_HOST.test(url.hostname);
}

export function webhookPayload(n: {
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly href?: string;
}): Record<string, string> {
  const text = `*${n.title}*\n${n.body}`;
  return { text, content: text, type: n.type, title: n.title, body: n.body, ...(n.href ? { href: n.href } : {}) };
}

/** Best effort: never throws, gives up after 5 s. */
export async function fanOutToWebhook(
  supabase: SupabaseClient,
  orgId: string,
  notification: { readonly type: string; readonly title: string; readonly body: string; readonly href?: string },
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("organizations")
      .select("notify_webhook_url")
      .eq("id", orgId)
      .maybeSingle();
    const url = (data?.notify_webhook_url as string | null | undefined) ?? null;
    if (!url || !isSafeWebhookUrl(url)) return false;

    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload(notification)),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) console.error(`[notifications] webhook for org ${orgId} returned ${response.status}`);
    return response.ok;
  } catch (err) {
    console.error(`[notifications] webhook for org ${orgId} failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
