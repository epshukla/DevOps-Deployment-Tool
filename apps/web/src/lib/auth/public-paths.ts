/**
 * Routes reachable without a session. Everything else is redirected to
 * /login by the auth proxy (src/proxy.ts).
 *
 * Matching is by whole path segment so `/invite` does not also expose,
 * say, a future `/invites-admin` page.
 */
const PUBLIC_PREFIXES = ["/login", "/auth", "/invite"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
