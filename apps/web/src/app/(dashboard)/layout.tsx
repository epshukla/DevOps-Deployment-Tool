import { Sidebar } from "@/components/layout/sidebar";
import { NavProvider } from "@/components/layout/nav-context";
import {
  UserProvider,
  type NotificationData,
} from "@/components/layout/user-context";
import {
  requireUser,
  listUserOrgs,
  resolveActiveOrg,
} from "@/lib/auth/session";
import { NOTIFICATION_PAGE_SIZE } from "@deployx/shared";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { supabase, user } = await requireUser();

  const avatarUrl =
    (user.user_metadata?.avatar_url as string | undefined) ?? null;
  const displayName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.user_name as string | undefined) ??
    user.email ??
    "User";

  const userEmail = user.email?.toLowerCase();
  const orgs = await listUserOrgs(supabase, user.id);
  const activeOrg = await resolveActiveOrg(orgs);

  // Personal notifications plus org-wide broadcasts, for the active org only
  const notificationFilter = `user_id.eq.${user.id},user_id.is.null`;
  const scopeToOrg = <T extends { eq: (column: string, value: string) => T }>(query: T) =>
    activeOrg ? query.eq("org_id", activeOrg.id) : query;

  const [notificationsResult, unreadResult, invitesResult] = await Promise.all([
    scopeToOrg(
      supabase
        .from("notifications")
        .select("id, type, title, body, metadata, is_read, created_at")
        .or(notificationFilter),
    )
      .order("created_at", { ascending: false })
      .limit(NOTIFICATION_PAGE_SIZE),
    scopeToOrg(
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .or(notificationFilter),
    ).eq("is_read", false),
    userEmail
      ? supabase
          .from("org_invites")
          .select("id", { count: "exact", head: true })
          .eq("email", userEmail)
          .is("accepted_at", null)
          .gt("expires_at", new Date().toISOString())
      : Promise.resolve({ count: 0 }),
  ]);

  return (
    <UserProvider
      userId={user.id}
      avatarUrl={avatarUrl}
      displayName={displayName}
      notifications={(notificationsResult.data ?? []) as NotificationData[]}
      unreadCount={unreadResult.count ?? 0}
      orgs={orgs}
      activeOrgId={activeOrg?.id ?? null}
      pendingInviteCount={invitesResult.count ?? 0}
    >
      <NavProvider>
        <Sidebar />
        <main className="min-h-screen lg:ml-56 page-enter">{children}</main>
      </NavProvider>
    </UserProvider>
  );
}
