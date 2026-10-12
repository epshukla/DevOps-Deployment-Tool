"use client";

import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { NotificationDropdown } from "./notification-dropdown";
import { GlobalSearch } from "./global-search";
import { useUser, type NotificationData } from "./user-context";
import { useNav } from "./nav-context";

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
  const { open, setOpen } = useNav();

  return (
    <header className="sticky top-0 z-30 flex h-14 w-full items-center gap-3 border-b border-outline-variant bg-surface/90 px-4 backdrop-blur-md md:px-6">
      {/* Mobile: open the navigation drawer */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="app-sidebar"
        className="grid h-9 w-9 place-items-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface lg:hidden"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[20px]">
          menu
        </span>
      </button>

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px] text-on-surface-variant">
          {breadcrumbs?.map((crumb, i) => {
            const last = i === (breadcrumbs?.length ?? 0) - 1;
            return (
              <li
                key={`${crumb.label}-${i}`}
                className={`flex min-w-0 items-center gap-1.5 ${last ? "" : "hidden sm:flex"}`}
              >
                {i > 0 && (
                  <span aria-hidden="true" className="text-on-surface-variant/40">
                    /
                  </span>
                )}
                {crumb.href && !last ? (
                  <Link
                    href={crumb.href}
                    className="truncate transition-colors hover:text-on-surface"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="truncate font-medium text-on-surface">
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Right side: search, notifications, avatar */}
      <div className="flex items-center gap-2 md:gap-3">
        <div className="hidden md:block">
          <GlobalSearch />
        </div>
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
        <Link href="/profile" aria-label="Your profile" className="rounded-full">
          <Avatar name={displayName} url={avatarUrl} size="sm" decorative />
        </Link>
      </div>
    </header>
  );
}
