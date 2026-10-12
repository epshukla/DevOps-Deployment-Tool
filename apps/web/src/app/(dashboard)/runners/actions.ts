"use server";

import { revalidatePath } from "next/cache";
import { requireUserWithOrg } from "@/lib/auth/session";
import { generateToken } from "@/lib/auth/runner";
import { hasMinRole } from "@deployx/shared";
import { recordAuditEvent } from "@/lib/audit";

export interface GenerateTokenResult {
  readonly token?: string;
  readonly runner_id?: string;
  readonly error?: string;
}

/**
 * Generate a registration token for a new runner.
 * Creates a runner_registrations row with the token hash.
 * Returns the plaintext token (shown to user once).
 */
export async function generateRunnerToken(
  _prev: GenerateTokenResult,
  formData: FormData,
): Promise<GenerateTokenResult> {
  const { supabase, user, org, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "admin")) {
    return { error: "You need admin permissions to register runners" };
  }

  const name = formData.get("name") as string | null;
  if (!name || name.trim().length === 0) {
    return { error: "Runner name is required" };
  }

  const { token, hash } = generateToken();
  const trimmedName = name.trim();

  const { data: runner, error } = await supabase
    .from("runner_registrations")
    .insert({
      org_id: org.id,
      name: trimmedName,
      token_hash: hash,
      status: "offline",
      capabilities: [],
    })
    .select("id")
    .single();

  if (error || !runner) {
    return { error: "Failed to create runner registration" };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "create",
    resource_type: "runner_registration",
    resource_id: runner.id,
    details: { name: trimmedName },
  });

  revalidatePath("/runners");

  return {
    token,
    runner_id: runner.id,
  };
}

export interface RevokeRunnerResult {
  readonly error?: string;
  readonly success?: boolean;
  /** Set when the revoke was refused because the runner is busy; retry with force=true. */
  readonly busy?: boolean;
}

/**
 * Revoke (delete) a runner registration, invalidating its token.
 * Refuses if the runner is currently busy with a job unless forced.
 */
export async function revokeRunner(
  runnerId: string,
  force = false,
): Promise<RevokeRunnerResult> {
  const { supabase, user, org, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "admin")) {
    return { error: "You need admin permissions to revoke runners" };
  }

  const { data: runner } = await supabase
    .from("runner_registrations")
    .select("id, name, current_job_id")
    .eq("id", runnerId)
    .eq("org_id", org.id)
    .single();

  if (!runner) {
    return { error: "Runner not found" };
  }

  if (runner.current_job_id && !force) {
    return {
      error: "This runner is currently busy with a job. Force revoke to proceed anyway.",
      busy: true,
    };
  }

  const { data: deletedRows, error } = await supabase
    .from("runner_registrations")
    .delete()
    .eq("id", runnerId)
    .eq("org_id", org.id)
    .select("id");

  if (error) {
    return { error: "Failed to revoke runner" };
  }

  if (!deletedRows || deletedRows.length === 0) {
    return { error: "Runner not found or not permitted" };
  }

  await recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "delete",
    resource_type: "runner_registration",
    resource_id: runnerId,
    details: { name: runner.name, forced: Boolean(force && runner.current_job_id) },
  });

  revalidatePath("/runners");

  return { success: true };
}
