"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requireUserWithOrg } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { switchActiveOrg } from "@/lib/auth/org-actions";
import { inviteErrorMessage, sendInviteEmail } from "@/lib/invites";
import {
  InviteMemberSchema,
  UpdateRoleSchema,
  hasMinRole,
} from "@deployx/shared";

/** A freshly created invite, so the admin can copy its link right away. */
export interface CreatedInvite {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly token: string;
  readonly expires_at: string;
}

interface ActionResult {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  readonly success?: boolean;
  readonly invite?: CreatedInvite;
}

type ServerClient = Awaited<ReturnType<typeof requireUserWithOrg>>["supabase"];

/**
 * Insert an invite row; the database generates the token and expiry.
 * Returns the row, or the raw insert error code ("23505" = duplicate).
 */
async function insertInvite(
  supabase: ServerClient,
  values: {
    readonly orgId: string;
    readonly email: string;
    readonly role: string;
    readonly invitedBy: string;
  },
): Promise<{ readonly invite?: CreatedInvite; readonly errorCode?: string }> {
  const { data, error } = await supabase
    .from("org_invites")
    .insert({
      org_id: values.orgId,
      email: values.email,
      role: values.role,
      invited_by: values.invitedBy,
    })
    .select("id, email, role, token, expires_at")
    .single();

  if (error || !data) {
    return { errorCode: error?.code ?? "no_row" };
  }
  return { invite: data as CreatedInvite };
}

/**
 * Hand the invite to the email seam. Never fails the action: the admin
 * always gets the link to share by hand.
 */
async function notifyInvitee(invite: CreatedInvite, orgName: string) {
  try {
    const result = await sendInviteEmail({
      email: invite.email,
      orgName,
      role: invite.role,
      token: invite.token,
      expiresAt: invite.expires_at,
    });
    if (!result.sent && result.reason !== "email not configured") {
      console.error("[settings] Invite email not sent:", result.reason);
    }
  } catch (err) {
    console.error("[settings] Invite email failed:", err);
  }
}

/**
 * Invite a user to the organization by email.
 * Only admins and owners can invite.
 */
export async function inviteMember(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { supabase, user, org, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "admin")) {
    return { error: "Only admins and owners can invite members" };
  }

  const raw = {
    email: (formData.get("email") as string | null)?.trim(),
    role: formData.get("role") as string | null,
  };

  const parsed = InviteMemberSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Mirrors updateMemberRole: only owners can create admins
  if (role === "admin" && parsed.data.role === "admin") {
    return { error: "Only owners can invite admins" };
  }

  // Check for existing membership by looking up user by email
  const { data: authUser } = await supabase.rpc("get_user_id_by_email" as never, {
    lookup_email: parsed.data.email,
  });

  // If user exists and is already a member, return error
  if (authUser) {
    const userId = (authUser as unknown as string);
    const { data: membership } = await supabase
      .from("org_memberships")
      .select("id")
      .eq("org_id", org.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (membership) {
      return { error: "This user is already a member of the organization" };
    }
  }

  const { invite, errorCode } = await insertInvite(supabase, {
    orgId: org.id,
    email: parsed.data.email,
    role: parsed.data.role,
    invitedBy: user.id,
  });

  if (!invite) {
    if (errorCode === "23505") {
      return {
        error:
          "An invite for this email already exists — copy its link or resend it below",
      };
    }
    return { error: "Failed to create invite" };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "create",
    resource_type: "invite",
    resource_id: invite.id,
    details: { email: invite.email, role: invite.role },
  });

  await notifyInvitee(invite, org.name);

  revalidatePath("/settings");
  return { success: true, invite };
}

/**
 * Replace a pending (typically expired) invite with a fresh one for the same
 * email and role: new token, new expiry. The old link stops working.
 * Only admins and owners; admins cannot re-issue admin invites.
 */
export async function resendInvite(inviteId: string): Promise<ActionResult> {
  const { supabase, user, org, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "admin")) {
    return { error: "Only admins and owners can resend invites" };
  }

  const { data: old } = await supabase
    .from("org_invites")
    .select("id, email, role, accepted_at")
    .eq("id", inviteId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!old) {
    return { error: "Invite not found" };
  }
  if (old.accepted_at) {
    return { error: "This invite has already been accepted" };
  }
  if (role === "admin" && old.role === "admin") {
    return { error: "Only owners can invite admins" };
  }

  // Delete first: (org_id, email) may be unique among invites
  const { data: deleted, error: deleteError } = await supabase
    .from("org_invites")
    .delete()
    .eq("id", inviteId)
    .eq("org_id", org.id)
    .is("accepted_at", null)
    .select("id");

  if (deleteError || !deleted || deleted.length === 0) {
    return { error: "Failed to replace invite — it may have just been accepted" };
  }

  const { invite } = await insertInvite(supabase, {
    orgId: org.id,
    email: old.email as string,
    role: old.role as string,
    invitedBy: user.id,
  });

  if (!invite) {
    revalidatePath("/settings");
    return {
      error: `The old invite was removed but a new one could not be created. Invite ${old.email as string} again.`,
    };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "create",
    resource_type: "invite",
    resource_id: invite.id,
    details: { email: invite.email, role: invite.role, replaces: inviteId },
  });

  await notifyInvitee(invite, org.name);

  revalidatePath("/settings");
  return { success: true, invite };
}

/**
 * Update a member's role in the organization.
 * Only admins and owners can change roles.
 * Cannot change the owner's role (ownership transfer is separate).
 * Cannot promote to owner via this action.
 */
export async function updateMemberRole(
  memberId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { supabase, org, role: callerRole, user } = await requireUserWithOrg();

  if (!hasMinRole(callerRole, "admin")) {
    return { error: "Only admins and owners can change member roles" };
  }

  const parsed = UpdateRoleSchema.safeParse({
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Cannot change own role
  if (memberId === user.id) {
    return { error: "You cannot change your own role" };
  }

  // Fetch target member's current role
  const { data: targetMembership } = await supabase
    .from("org_memberships")
    .select("id, role, user_id")
    .eq("org_id", org.id)
    .eq("user_id", memberId)
    .single();

  if (!targetMembership) {
    return { error: "Member not found" };
  }

  // Cannot change the owner's role
  if (targetMembership.role === "owner") {
    return { error: "Cannot change the organization owner's role" };
  }

  // Admins cannot manage other admins (mirrors removeMember)
  if (callerRole === "admin" && targetMembership.role === "admin") {
    return { error: "Admins cannot change another admin's role" };
  }

  // Admins cannot promote to admin (only owners can)
  if (callerRole === "admin" && parsed.data.role === "admin") {
    return { error: "Only owners can promote members to admin" };
  }

  const { error } = await supabase
    .from("org_memberships")
    .update({ role: parsed.data.role })
    .eq("org_id", org.id)
    .eq("user_id", memberId);

  if (error) {
    return { error: "Failed to update member role" };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "update",
    resource_type: "membership",
    resource_id: memberId,
    details: { newRole: parsed.data.role },
  });

  revalidatePath("/settings");
  return { success: true };
}

/**
 * Remove a member from the organization.
 * Only admins and owners can remove members.
 * The owner cannot be removed.
 */
export async function removeMember(
  memberId: string,
): Promise<ActionResult> {
  const { supabase, user, org, role: callerRole } = await requireUserWithOrg();

  if (!hasMinRole(callerRole, "admin")) {
    return { error: "Only admins and owners can remove members" };
  }

  // Cannot remove yourself
  if (memberId === user.id) {
    return { error: "You cannot remove yourself from the organization" };
  }

  // Check target member exists and is not owner
  const { data: targetMembership } = await supabase
    .from("org_memberships")
    .select("id, role")
    .eq("org_id", org.id)
    .eq("user_id", memberId)
    .single();

  if (!targetMembership) {
    return { error: "Member not found" };
  }

  if (targetMembership.role === "owner") {
    return { error: "Cannot remove the organization owner" };
  }

  // Admins cannot remove other admins
  if (callerRole === "admin" && targetMembership.role === "admin") {
    return { error: "Admins cannot remove other admins" };
  }

  const { error } = await supabase
    .from("org_memberships")
    .delete()
    .eq("org_id", org.id)
    .eq("user_id", memberId);

  if (error) {
    return { error: "Failed to remove member" };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "delete",
    resource_type: "membership",
    resource_id: memberId,
  });

  revalidatePath("/settings");
  return { success: true };
}

/**
 * Cancel a pending invite.
 * Only admins and owners can cancel invites.
 */
export async function cancelInvite(
  inviteId: string,
): Promise<ActionResult> {
  const { supabase, user, org, role: callerRole } = await requireUserWithOrg();

  if (!hasMinRole(callerRole, "admin")) {
    return { error: "Only admins and owners can cancel invites" };
  }

  const { data: deleted, error } = await supabase
    .from("org_invites")
    .delete()
    .eq("id", inviteId)
    .eq("org_id", org.id)
    .select("id, email");

  if (error) {
    return { error: "Failed to cancel invite" };
  }
  if (!deleted || deleted.length === 0) {
    return { error: "Invite not found" };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "delete",
    resource_type: "invite",
    resource_id: inviteId,
    details: { email: deleted[0].email },
  });

  revalidatePath("/settings");
  return { success: true };
}

/*
 * In-app banner path (Settings shows invites addressed to your email).
 *
 * The banner has no token, so these call the *_by_id SECURITY DEFINER RPCs,
 * which authorise by matching the caller's auth email to the invite email.
 * They must be SECURITY DEFINER: org_memberships RLS only lets admins insert,
 * so the invitee's own session could never create its membership directly.
 * The RPCs share one locked code path with the link flow, so expiry,
 * single-use and audit logging behave identically in both.
 */

/**
 * Accept a pending invite addressed to the current user's email.
 */
export async function acceptInvite(inviteId: string): Promise<ActionResult> {
  const { supabase } = await requireUser();

  const { data: orgId, error } = await supabase.rpc(
    "accept_org_invite_by_id" as never,
    { p_invite_id: inviteId } as never,
  );

  if (error || typeof orgId !== "string") {
    console.error("[settings] accept_org_invite_by_id failed:", error?.message ?? "no org id");
    return { error: inviteErrorMessage(error) };
  }

  // Land the user in the org they just joined
  const switched = await switchActiveOrg(orgId);
  if (switched.error) {
    console.error("[settings] switchActiveOrg failed:", switched.error);
  }

  revalidatePath("/", "layout");
  return { success: true };
}

/**
 * Decline a pending invite addressed to the current user's email.
 */
export async function declineInvite(inviteId: string): Promise<ActionResult> {
  const { supabase } = await requireUser();

  const { error } = await supabase.rpc(
    "decline_org_invite_by_id" as never,
    { p_invite_id: inviteId } as never,
  );

  if (error) {
    console.error("[settings] decline_org_invite_by_id failed:", error.message);
    return { error: inviteErrorMessage(error) };
  }

  revalidatePath("/settings");
  return { success: true };
}

const ORG_NAME_MAX_LENGTH = 100;

/**
 * Rename the active organization. Admins and owners only.
 */
export async function updateOrganizationName(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { supabase, user, org, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "admin")) {
    return { error: "Only admins and owners can rename the organization" };
  }

  const name = (formData.get("name") as string | null)?.trim() ?? "";
  if (name.length === 0) {
    return { fieldErrors: { name: ["Organization name is required"] } };
  }
  if (name.length > ORG_NAME_MAX_LENGTH) {
    return {
      fieldErrors: {
        name: [`Name must be ${ORG_NAME_MAX_LENGTH} characters or fewer`],
      },
    };
  }
  if (name === org.name) {
    return { success: true };
  }

  const { data: updated, error } = await supabase
    .from("organizations")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", org.id)
    .select("id");

  if (error || !updated || updated.length === 0) {
    return { error: "Failed to rename organization" };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "update",
    resource_type: "organization",
    resource_id: org.id,
    details: { from: org.name, to: name },
  });

  revalidatePath("/", "layout");
  return { success: true };
}

/**
 * Permanently delete the active organization and everything it owns.
 * Owner only, and the caller must type the org slug to confirm.
 */
export async function deleteOrganization(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { supabase, user, org, role } = await requireUserWithOrg();

  if (role !== "owner") {
    return { error: "Only the organization owner can delete it" };
  }

  const confirmation = (formData.get("confirm_slug") as string | null)?.trim();
  if (confirmation !== org.slug) {
    return {
      fieldErrors: {
        confirm_slug: [`Type "${org.slug}" exactly to confirm`],
      },
    };
  }

  const { data: deleted, error } = await supabase
    .from("organizations")
    .delete()
    .eq("id", org.id)
    .select("id");

  if (error || !deleted || deleted.length === 0) {
    return {
      error: `Failed to delete organization${error ? `: ${error.message}` : ""}`,
    };
  }

  // The audit log row would be cascaded with the org, so log server-side.
  console.info(
    `[settings] Organization ${org.id} (${org.slug}) deleted by ${user.id}`,
  );

  revalidatePath("/", "layout");
  return { success: true };
}
