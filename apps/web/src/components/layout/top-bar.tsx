"use client";

import Link from "next/link";
import { NotificationDropdown } from "./notification-dropdown";
import { GlobalSearch } from "./global-search";
import { useUser, type NotificationData } from "./user-context";

interface TopBarProps {
  readonly breadcrumbs?: ReadonlyArray<{
    readonly label: string;
    readonly href?: string;
  }>;
  readonly userId?: string;
  readonly initialNotifications?: readonly NotificationData[];
  readonly initialUnreadCount?: number;
}

export function TopBar({
  breadcrumbs,
  userId,
  initialNotifications,
  initialUnreadCount,
}: TopBarProps) {
  const user = useUser();
  const { avatarUrl, displayName } = user;
  // Pages may still pass notification props explicitly; otherwise the
  // dashboard layout supplies them through UserContext.
  const effectiveUserId = userId ?? user.userId;

  return (
    <header className="flex items-center justify-between h-14 pl-8 pr-8 w-full sticky top-0 z-40 bg-surface/80 backdrop-blur-xl">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-on-surface-variant text-sm">
        {breadcrumbs?.map((crumb, i) => (
          <span key={crumb.label} className="flex items-center gap-2">
            {i > 0 && (
              <span aria-hidden="true" className="material-symbols-outlined text-sm">
                chevron_right
              </span>
            )}
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="hover:text-primary transition-colors"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="text-on-surface font-semibold">
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </div>

      {/* Right side: search, notifications, avatar */}
      <div className="flex items-center gap-6">
        <GlobalSearch />
        <div className="flex items-center gap-4 text-on-surface-variant/60">
          {effectiveUserId && (
            <NotificationDropdown
              // Remount on org switch so state re-seeds from the new org
              key={user.activeOrgId ?? "none"}
              userId={effectiveUserId}
              orgId={user.activeOrgId}
              initialNotifications={initialNotifications ?? user.notifications}
              initialUnreadCount={initialUnreadCount ?? user.unreadCount}
            />
          )}
          <div className="w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center overflow-hidden border border-outline-variant/30">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={displayName}
                className="w-full h-full object-cover"
              />
            ) : (
              <span aria-hidden="true" className="material-symbols-outlined text-on-surface-variant">
                person
              </span>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
