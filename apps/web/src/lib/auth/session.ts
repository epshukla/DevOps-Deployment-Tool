import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { OrgRole } from "@deployx/shared";

/** Cookie holding the org the user is currently viewing (multi-org users). */
export const ACTIVE_ORG_COOKIE = "deployx_active_org";

export interface MembershipOrg {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
}

/**
 * All orgs the user belongs to, oldest membership first (deterministic order).
 */
export async function listUserOrgs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<readonly MembershipOrg[]> {
  const { data } = await supabase
    .from("org_memberships")
    .select("org_id, role, created_at, organizations(id, name, slug)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  return (data ?? [])
    .map((m) => {
      const org = m.organizations as unknown as {
        id: string;
        name: string;
        slug: string;
      } | null;
      return org ? { ...org, role: m.role as string } : null;
    })
    .filter((o): o is MembershipOrg => o !== null);
}

/**
 * Pick the active org: the cookie's org if the user still belongs to it,
 * otherwise their oldest membership.
 */
export async function resolveActiveOrg(
  orgs: readonly MembershipOrg[],
): Promise<MembershipOrg | null> {
  if (orgs.length === 0) return null;
  const cookieStore = await cookies();
  const preferred = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  return orgs.find((o) => o.id === preferred) ?? orgs[0];
}

/**
 * Get the authenticated user or redirect to login.
 * Use in Server Components and Server Actions.
 */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/login");
  }

  return { supabase, user };
}

/**
 * Get the user's organization (auto-creates a personal org on first login).
 * Every user must belong to at least one org to use the platform.
 */
export async function requireUserWithOrg() {
  const { supabase, user } = await requireUser();

  // Check existing memberships; honour the active-org cookie
  const active = await resolveActiveOrg(await listUserOrgs(supabase, user.id));

  if (active) {
    const { role, ...org } = active;
    return { supabase, user, org, role: role as OrgRole };
  }

  // First-time user: create a personal org via SECURITY DEFINER function.
  // This bypasses RLS to avoid the chicken-and-egg problem where
  // org_memberships INSERT requires has_org_role() but the user
  // has no membership yet.
  const displayName =
    user.user_metadata?.full_name ??
    user.user_metadata?.user_name ??
    "User";
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48);

  const { data: newOrg, error: orgError } = await supabase.rpc(
    "bootstrap_user_org" as never,
    {
      org_name: `${displayName}'s Org`,
      org_slug: `${slug}-${Date.now()}`,
    },
  );

  if (orgError || !newOrg) {
    throw new Error(`Failed to create organization: ${orgError?.message}`);
  }

  const org = newOrg as unknown as { id: string; name: string; slug: string };

  return {
    supabase,
    user,
    org,
    role: "owner" as const,
  };
}
