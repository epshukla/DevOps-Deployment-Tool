"use client";

import Link from "next/link";
import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useUser } from "./user-context";
import { createClient } from "@/lib/supabase/client";
import { switchActiveOrg } from "@/lib/auth/org-actions";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: "dashboard" },
  { href: "/projects", label: "Projects", icon: "account_tree" },
  { href: "/runners", label: "Runners", icon: "memory" },
  { href: "/alerts", label: "Alerts", icon: "notifications_active" },
  { href: "/settings", label: "Settings", icon: "settings" },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { avatarUrl, displayName, orgs, activeOrgId } = useUser();
  const [switching, startSwitch] = useTransition();

  function handleOrgChange(orgId: string) {
    startSwitch(async () => {
      const result = await switchActiveOrg(orgId);
      if (!result.error) {
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
    <aside className="flex flex-col h-full w-[240px] z-50 bg-surface-container fixed left-0 top-0 text-sm tracking-tight">
      {/* Logo */}
      <div className="p-6 flex items-center gap-3">
        <div className="w-8 h-8 bg-gradient-to-br from-primary to-primary-container rounded-lg flex items-center justify-center">
          <span
            className="material-symbols-outlined text-on-primary text-lg"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            terminal
          </span>
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tighter text-primary">
            DeployX
          </h1>
          <p className="text-[10px] uppercase tracking-widest text-on-surface-variant/50 font-bold">
            v0.1.0
          </p>
        </div>
      </div>

      {/* Org switcher — only shown when the user belongs to several orgs */}
      {orgs.length > 1 && (
        <div className="px-6">
          <label
            htmlFor="org-switcher"
            className="block text-[10px] uppercase tracking-widest text-on-surface-variant/50 font-bold mb-1.5"
          >
            Organization
          </label>
          <select
            id="org-switcher"
            value={activeOrgId ?? ""}
            disabled={switching}
            onChange={(e) => handleOrgChange(e.target.value)}
            className="w-full bg-surface-container-high border border-outline-variant/20 rounded-md px-3 py-2 text-xs text-on-surface focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.role})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 mt-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-4 px-6 py-3 transition-colors ${
                active
                  ? "text-primary border-l-2 border-primary bg-surface-container-high"
                  : "text-on-surface-variant/60 hover:bg-surface-container-high hover:text-on-surface-variant"
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">
                {item.icon}
              </span>
              <span className={active ? "font-semibold" : ""}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Profile & Sign Out */}
      <div className="mt-auto border-t border-outline-variant/10">
        <div className="p-4 pb-2">
          <Link
            href="/profile"
            className="flex items-center gap-3 px-4 py-3 text-on-surface-variant/60 hover:bg-surface-container-high hover:text-on-surface-variant transition-colors rounded-lg"
          >
            <div className="w-7 h-7 rounded-full bg-surface-container-highest flex items-center justify-center overflow-hidden border border-outline-variant/30 flex-shrink-0">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="material-symbols-outlined text-[18px]">
                  account_circle
                </span>
              )}
            </div>
            <span className="truncate">{displayName}</span>
          </Link>
        </div>
        <div className="px-4 pb-4">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 w-full px-4 py-2.5 text-on-surface-variant/40 hover:bg-error/10 hover:text-error transition-colors rounded-lg text-sm"
          >
            <span className="material-symbols-outlined text-[20px]">
              logout
            </span>
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
