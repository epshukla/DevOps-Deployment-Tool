/**
 * Open-redirect guard for post-login `next` parameters.
 *
 * Only same-origin relative paths are allowed. Anything that a browser could
 * interpret as another origin falls back to `fallback`:
 *   - absolute URLs (`https://evil.com`, `javascript:...`)
 *   - protocol-relative paths (`//evil.com`)
 *   - backslash tricks (`/\evil.com`, which browsers normalise to `//`)
 *   - control characters (`/\t/evil.com` — browsers strip tabs/newlines)
 */

const MAX_REDIRECT_LENGTH = 2048;
const PROBE_ORIGIN = "http://redirect.invalid";
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeRedirectPath(
  value: string | null | undefined,
  fallback = "/",
): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (value.length > MAX_REDIRECT_LENGTH) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.includes("\\") || CONTROL_CHARS.test(value)) return fallback;

  // Final check: resolving against a probe origin must not leave it.
  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (resolved.origin !== PROBE_ORIGIN) return fallback;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * OAuth `redirectTo` for Supabase: `/auth/callback`, carrying a sanitized
 * `next` only when it points somewhere other than the dashboard root.
 */
export function buildAuthCallbackUrl(
  origin: string,
  next?: string | null,
): string {
  const target = safeRedirectPath(next);
  const base = `${origin}/auth/callback`;
  return target === "/" ? base : `${base}?next=${encodeURIComponent(target)}`;
}

/** `/login`, carrying a sanitized `next` when it is not the root. */
export function buildLoginPath(next?: string | null): string {
  const target = safeRedirectPath(next);
  return target === "/" ? "/login" : `/login?next=${encodeURIComponent(target)}`;
}
