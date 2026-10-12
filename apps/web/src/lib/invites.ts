/**
 * Server-side invite helpers: the email delivery seam and RPC error mapping.
 * Do not import from client components (the email sender will hold secrets).
 */

export interface InviteEmailPayload {
  readonly email: string;
  readonly orgName: string;
  readonly role: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly invitedByName?: string;
}

export interface InviteEmailResult {
  readonly sent: boolean;
  readonly reason?: string;
}

/**
 * Deliver an invite email. Intentionally a no-op today: admins share the
 * link by hand from Settings → Members.
 *
 * To enable email later (e.g. Resend), implement only this body:
 *   1. read RESEND_API_KEY / INVITE_FROM_EMAIL and an absolute site URL
 *      (e.g. NEXT_PUBLIC_SITE_URL) from the environment; return
 *      { sent: false, reason } if any are missing,
 *   2. build the link with inviteUrl(siteUrl, invite.token) from
 *      ./invite-links,
 *   3. send, and return { sent: true } or { sent: false, reason }.
 * Callers already treat a failed send as non-fatal — the invite exists and
 * the link is still shown to the admin.
 */
export async function sendInviteEmail(
  invite: InviteEmailPayload,
): Promise<InviteEmailResult> {
  void invite;
  return { sent: false, reason: "email not configured" };
}

/** Machine-readable errors raised by the invite RPCs (see the migration). */
const INVITE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_authenticated: "Please sign in to respond to this invite.",
  invite_not_found: "This invite link is invalid or has been cancelled.",
  invite_already_accepted: "This invite has already been used.",
  invite_expired: "This invite has expired. Ask an admin for a new link.",
  invite_invalid_role: "This invite grants an invalid role.",
  invite_email_mismatch: "This invite is not addressed to your email address.",
};

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

/** Turn a PostgREST error from an invite RPC into a user-facing message. */
export function inviteErrorMessage(
  error: { readonly message?: string | null } | null | undefined,
): string {
  const key = error?.message?.trim();
  return (key && INVITE_ERROR_MESSAGES[key]) || FALLBACK_MESSAGE;
}
