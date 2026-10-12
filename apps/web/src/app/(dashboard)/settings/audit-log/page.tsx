import { requireUserWithOrg } from "@/lib/auth/session";
import { loadProfiles } from "@/lib/profiles";
import { AuditLogClient } from "./audit-log-client";

const AUDIT_PAGE_SIZE = 50;

interface AuditLogPageProps {
  readonly searchParams: Promise<{
    readonly action?: string;
    readonly user?: string;
    readonly page?: string;
  }>;
}

export default async function AuditLogPage({ searchParams }: AuditLogPageProps) {
  const { supabase, org } = await requireUserWithOrg();
  const params = await searchParams;

  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const from = (page - 1) * AUDIT_PAGE_SIZE;

  // Filters run in the database so they cover the whole history, not just
  // the rows on the current page
  let query = supabase
    .from("audit_events")
    .select("id, user_id, action, resource_type, resource_id, details, created_at", {
      count: "exact",
    })
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .range(from, from + AUDIT_PAGE_SIZE - 1);
  if (params.action) query = query.eq("action", params.action);
  if (params.user) query = query.eq("user_id", params.user);

  const [{ data: events, count }, { data: memberships }] = await Promise.all([
    query,
    supabase.from("org_memberships").select("user_id").eq("org_id", org.id),
  ]);

  const profiles = await loadProfiles(supabase, [
    ...(memberships ?? []).map((m) => m.user_id as string),
    ...(events ?? []).map((e) => e.user_id as string),
  ]);
  const nameOf = (userId: string) => profiles.get(userId)?.display_name ?? "Unknown";

  return (
    <AuditLogClient
      orgId={org.id}
      events={(events ?? []).map((e) => ({
        id: e.id as string,
        user_id: e.user_id as string,
        user_name: nameOf(e.user_id as string),
        action: e.action as string,
        resource_type: e.resource_type as string,
        resource_id: e.resource_id as string,
        details: e.details as Record<string, unknown> | null,
        created_at: e.created_at as string,
      }))}
      members={(memberships ?? []).map((m) => ({
        user_id: m.user_id as string,
        display_name: nameOf(m.user_id as string),
      }))}
      filters={{ action: params.action ?? "", user: params.user ?? "" }}
      page={page}
      pageCount={Math.max(1, Math.ceil((count ?? 0) / AUDIT_PAGE_SIZE))}
      total={count ?? 0}
    />
  );
}
