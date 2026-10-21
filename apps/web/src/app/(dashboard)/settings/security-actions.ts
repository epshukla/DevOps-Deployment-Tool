"use server";

import { revalidatePath } from "next/cache";
import { requireUserWithOrg } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { isSafeWebhookUrl } from "@/lib/notify-webhook";

interface ActionResult {
  readonly error?: string;
  readonly success?: boolean;
}

/** Owner only: require Owners/Admins to sign in with a second factor. */
export async function setRequireMfa(enabled: boolean): Promise<ActionResult> {
  const { supabase, user, org, role } = await requireUserWithOrg();
  if (role !== "owner") return { error: "Only the owner can change the MFA policy" };

  if (enabled) {
    // Don't let the owner lock themselves out: they must be enrolled first
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.currentLevel !== "aal2") {
      return { error: "Set up two-factor authentication for your own account first" };
    }
  }

  const { data: updated, error } = await supabase
    .from("organizations")
    .update({ require_mfa: enabled })
    .eq("id", org.id)
    .select("id");
  if (error || !updated?.length) return { error: "Failed to update the MFA policy" };

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "update",
    resource_type: "organization",
    resource_id: org.id,
    details: { require_mfa: enabled },
  });
  revalidatePath("/settings");
  return { success: true };
}

/** Owner only (org RLS): where notifications are also POSTed (Slack/Discord/JSON). Empty clears it. */
export async function setNotifyWebhook(rawUrl: string): Promise<ActionResult> {
  const { supabase, user, org, role } = await requireUserWithOrg();
  if (role !== "owner") return { error: "Only the owner can change the notification webhook" };

  const url = rawUrl.trim() || null;
  if (url && !isSafeWebhookUrl(url)) {
    return { error: "Use a public https:// webhook URL" };
  }

  const { data: updated, error } = await supabase
    .from("organizations")
    .update({ notify_webhook_url: url })
    .eq("id", org.id)
    .select("id");
  if (error || !updated?.length) return { error: "Failed to save the webhook" };

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "update",
    resource_type: "organization",
    resource_id: org.id,
    details: { notify_webhook: url ? new URL(url).host : null },
  });
  revalidatePath("/settings");
  return { success: true };
}
