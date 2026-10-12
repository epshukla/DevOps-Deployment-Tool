import { Sidebar } from "@/components/layout/sidebar";
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

  const notificationFilter = `user_id.eq.${user.id},user_id.is.null`;

  const [orgs, notificationsResult, unreadResult] = await Promise.all([
    listUserOrgs(supabase, user.id),
    supabase
      .from("notifications")
      .select("id, type, title, body, metadata, is_read, created_at")
      .or(notificationFilter)
      .order("created_at", { ascending: false })
      .limit(NOTIFICATION_PAGE_SIZE),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .or(notificationFilter)
      .eq("is_read", false),
  ]);

  const activeOrg = await resolveActiveOrg(orgs);

  return (
    <UserProvider
      userId={user.id}
      avatarUrl={avatarUrl}
      displayName={displayName}
      notifications={(notificationsResult.data ?? []) as NotificationData[]}
      unreadCount={unreadResult.count ?? 0}
      orgs={orgs}
      activeOrgId={activeOrg?.id ?? null}
    >
      <Sidebar />
      <main className="ml-[240px] min-h-screen">{children}</main>
    </UserProvider>
  );
}
