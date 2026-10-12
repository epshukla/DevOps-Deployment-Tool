/**
 * Pure, client-safe helpers for shareable invite links.
 * (Server-only invite logic lives in ./invites.ts.)
 */

/** Tokens are 48 hex chars today; accept a URL-safe superset defensively. */
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type InvitePreviewStatus = "pending" | "accepted" | "expired";

export interface InvitePreview {
  readonly org_name: string;
  readonly role: string;
  readonly email: string;
  readonly expires_at: string;
  readonly status: InvitePreviewStatus;
}

/** Cheap shape check so obviously bogus URLs never reach the database. */
export function isPlausibleInviteToken(token: unknown): token is string {
  return typeof token === "string" && INVITE_TOKEN_PATTERN.test(token);
}

export function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}${invitePath(token)}`;
}

export function isInviteExpired(expiresAt: string, now: Date): boolean {
  const expiry = new Date(expiresAt).getTime();
  return Number.isNaN(expiry) || expiry <= now.getTime();
}

const PREVIEW_STATUSES: readonly InvitePreviewStatus[] = [
  "pending",
  "accepted",
  "expired",
];

/**
 * Validate the row returned by the `get_invite_preview` RPC (it returns a
 * set, so supabase-js hands back an array). Returns null for anything that
 * doesn't look like a preview — callers render "invalid link".
 */
export function parseInvitePreview(data: unknown): InvitePreview | null {
  const row: unknown = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r.org_name !== "string" ||
    typeof r.role !== "string" ||
    typeof r.email !== "string" ||
    typeof r.expires_at !== "string" ||
    !PREVIEW_STATUSES.includes(r.status as InvitePreviewStatus)
  ) {
    return null;
  }
  return {
    org_name: r.org_name,
    role: r.role,
    email: r.email,
    expires_at: r.expires_at,
    status: r.status as InvitePreviewStatus,
  };
}
