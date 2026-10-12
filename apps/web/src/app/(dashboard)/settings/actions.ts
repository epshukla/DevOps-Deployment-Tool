"use server";

import { revalidatePath } from "next/cache";
import { requireUserWithOrg } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { switchActiveOrg } from "@/lib/auth/org-actions";
import {
  InviteMemberSchema,
  UpdateRoleSchema,
  hasMinRole,
} from "@deployx/shared";

interface ActionResult {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  readonly success?: boolean;
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

  // Create invite
  const { error } = await supabase.from("org_invites").insert({
    org_id: org.id,
    email: parsed.data.email,
    role: parsed.data.role,
    invited_by: user.id,
  });

  if (error) {
    if (error.code === "23505") {
      return { error: "An invite for this email already exists" };
    }
    return { error: "Failed to create invite" };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "create",
    resource_type: "invite",
    resource_id: org.id,
    details: { email: parsed.data.email, role: parsed.data.role },
  });

  revalidatePath("/settings");
  return { success: true };
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

/**
 * Accept a pending invite addressed to the current user.
 * Creates an org_membership and marks the invite as accepted.
 */
export async function acceptInvite(
  inviteId: string,
): Promise<ActionResult> {
  const { supabase, user } = await requireUserWithOrg();

  const userEmail = user.email;
  if (!userEmail) {
    return { error: "Cannot determine your email address" };
  }

  // Fetch the invite
  const { data: invite } = await supabase
    .from("org_invites")
    .select("id, org_id, email, role, accepted_at, expires_at")
    .eq("id", inviteId)
    .single();

  if (!invite) {
    return { error: "Invite not found" };
  }

  if (invite.email !== userEmail.toLowerCase()) {
    return { error: "This invite is not addressed to you" };
  }

  if (invite.accepted_at) {
    return { error: "This invite has already been accepted" };
  }

  if (new Date(invite.expires_at) < new Date()) {
    return { error: "This invite has expired" };
  }

  // Check if already a member
  const { data: existingMembership } = await supabase
    .from("org_memberships")
    .select("id")
    .eq("org_id", invite.org_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingMembership) {
    return { error: "You are already a member of this organization" };
  }

  // Create membership
  const { error: memberError } = await supabase
    .from("org_memberships")
    .insert({
      org_id: invite.org_id,
      user_id: user.id,
      role: invite.role,
    });

  if (memberError) {
    return { error: "Failed to join organization" };
  }

  // Mark invite as accepted
  await supabase
    .from("org_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", inviteId);

  await recordAuditEvent(supabase, {
    org_id: invite.org_id,
    user_id: user.id,
    action: "create",
    resource_type: "membership",
    resource_id: user.id,
    details: { via: "invite", role: invite.role },
  });

  // Land the user in the org they just joined
  await switchActiveOrg(invite.org_id);

  revalidatePath("/", "layout");
  return { success: true };
}

/**
 * Decline a pending invite addressed to the current user.
 */
export async function declineInvite(
  inviteId: string,
): Promise<ActionResult> {
  const { supabase, user } = await requireUserWithOrg();

  const userEmail = user.email;
  if (!userEmail) {
    return { error: "Cannot determine your email address" };
  }

  const { data: invite } = await supabase
    .from("org_invites")
    .select("id, email")
    .eq("id", inviteId)
    .single();

  if (!invite) {
    return { error: "Invite not found" };
  }

  if (invite.email !== userEmail.toLowerCase()) {
    return { error: "This invite is not addressed to you" };
  }

  const { error } = await supabase
    .from("org_invites")
    .delete()
    .eq("id", inviteId);

  if (error) {
    return { error: "Failed to decline invite" };
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
