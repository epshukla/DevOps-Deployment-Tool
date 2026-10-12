"use client";

import Link from "next/link";
import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { useUser } from "./user-context";
import { useNav } from "./nav-context";
import { createClient } from "@/lib/supabase/client";
import { switchActiveOrg } from "@/lib/auth/org-actions";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: "space_dashboard" },
  { href: "/projects", label: "Projects", icon: "folder" },
  { href: "/runners", label: "Runners", icon: "dns" },
  { href: "/alerts", label: "Alerts", icon: "notifications" },
  { href: "/settings", label: "Settings", icon: "tune" },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { avatarUrl, displayName, orgs, activeOrgId, pendingInviteCount } = useUser();
  const { open, setOpen } = useNav();
  const [switching, startSwitch] = useTransition();
  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  function handleOrgChange(orgId: string) {
    startSwitch(async () => {
      const result = await switchActiveOrg(orgId);
      if (!result.error) {
        setOpen(false);
        router.push("/");
        router.refresh();
      }
    });
  }

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <>
      {/* Scrim for the mobile drawer */}
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      )}

      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-56 flex-col border-r border-outline-variant bg-surface-container-low transition-transform duration-200 lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-2.5 border-b border-outline-variant px-4">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-on-primary">
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              rocket_launch
            </span>
          </span>
          <span className="font-mono text-[15px] font-semibold tracking-tight">DeployX</span>
        </div>

        {/* Organization */}
        <div className="border-b border-outline-variant px-3 py-3">
          {orgs.length > 1 ? (
            <>
              <label htmlFor="org-switcher" className="sr-only">
                Organization
              </label>
              <select
                id="org-switcher"
                value={activeOrgId ?? ""}
                disabled={switching}
                onChange={(e) => handleOrgChange(e.target.value)}
                className="h-8 w-full rounded-md border border-outline-variant bg-surface-container px-2 text-[13px] text-on-surface disabled:opacity-50"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <p className="truncate px-1 text-[13px] text-on-surface-variant" title={activeOrg?.name}>
              {activeOrg?.name ?? "Personal"}
            </p>
          )}
        </div>

        {/* Navigation */}
        <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-150 ${
                  active
                    ? "bg-surface-container-high font-medium text-on-surface"
                    : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
                }`}
              >
                {active && (
                  <span aria-hidden="true" className="absolute -left-2 top-1.5 bottom-1.5 w-0.5 rounded-full bg-on-surface" />
                )}
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                  {item.icon}
                </span>
                <span className="flex-1">{item.label}</span>
                {item.href === "/settings" && pendingInviteCount > 0 && (
                  <span
                    className="grid h-4 min-w-4 place-items-center rounded-full bg-warning px-1 font-mono text-[10px] font-semibold text-on-warning"
                    title={`${pendingInviteCount} pending invite(s)`}
                  >
                    {pendingInviteCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Account */}
        <div className="flex items-center gap-2 border-t border-outline-variant px-3 py-3">
          <Link
            href="/profile"
            onClick={() => setOpen(false)}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-[13px] text-on-surface-variant transition-colors hover:text-on-surface"
          >
            <Avatar name={displayName} url={avatarUrl} size="xs" decorative />
            <span className="truncate">{displayName}</span>
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="grid h-8 w-8 place-items-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-container hover:text-error"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
              logout
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}
