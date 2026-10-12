"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { switchActiveOrg } from "@/lib/auth/org-actions";
import { isPlausibleInviteToken } from "@/lib/invite-links";
import { inviteErrorMessage } from "@/lib/invites";

interface InviteResponseResult {
  readonly error?: string;
  readonly success?: boolean;
}

/**
 * Validate the token shape and require a session. Returns the client, or a
 * user-facing error. (Not `requireUser()`: its /login redirect would drop
 * the invite context; the page offers sign-in itself.)
 */
async function authorise(
  token: string,
): Promise<
  | { readonly supabase: Awaited<ReturnType<typeof createClient>> }
  | { readonly error: string }
> {
  if (!isPlausibleInviteToken(token)) {
    return { error: inviteErrorMessage({ message: "invite_not_found" }) };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: inviteErrorMessage({ message: "not_authenticated" }) };
  }
  return { supabase };
}

/**
 * Redeem an invite link for the signed-in user. The SECURITY DEFINER RPC
 * creates the membership (org_memberships RLS only lets admins insert),
 * marks the invite accepted and writes the audit event. On success the
 * user is switched into the new org and sent to the dashboard.
 */
export async function acceptInviteLink(
  token: string,
): Promise<InviteResponseResult> {
  const auth = await authorise(token);
  if ("error" in auth) return { error: auth.error };

  const { data: orgId, error } = await auth.supabase.rpc(
    "accept_org_invite" as never,
    { p_token: token } as never,
  );

  if (error || typeof orgId !== "string") {
    console.error("[invite] accept_org_invite failed:", error?.message ?? "no org id");
    return { error: inviteErrorMessage(error) };
  }

  const switched = await switchActiveOrg(orgId);
  if (switched.error) {
    // Membership exists; the dashboard just falls back to the oldest org.
    console.error("[invite] switchActiveOrg failed:", switched.error);
  }

  revalidatePath("/", "layout");
  redirect("/");
}

/** Discard an invite link (deletes the pending invite). */
export async function declineInviteLink(
  token: string,
): Promise<InviteResponseResult> {
  const auth = await authorise(token);
  if ("error" in auth) return { error: auth.error };

  const { error } = await auth.supabase.rpc(
    "decline_org_invite" as never,
    { p_token: token } as never,
  );

  if (error) {
    console.error("[invite] decline_org_invite failed:", error.message);
    return { error: inviteErrorMessage(error) };
  }

  return { success: true };
}
