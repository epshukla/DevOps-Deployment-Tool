"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser, listUserOrgs, ACTIVE_ORG_COOKIE } from "./session";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Switch the org the dashboard is scoped to. Only orgs the caller is a
 * member of are accepted, so the cookie can never grant access by itself
 * (RLS still enforces membership on every query).
 */
export async function switchActiveOrg(
  orgId: string,
): Promise<{ readonly error?: string }> {
  const { supabase, user } = await requireUser();
  const orgs = await listUserOrgs(supabase, user.id);

  if (!orgs.some((o) => o.id === orgId)) {
    return { error: "You are not a member of that organization" };
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ONE_YEAR_SECONDS,
  });

  revalidatePath("/", "layout");
  return {};
}
