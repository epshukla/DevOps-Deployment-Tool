"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: "dashboard" },
  { href: "/projects", label: "Projects", icon: "account_tree" },
  { href: "/runners", label: "Runners", icon: "memory" },
  { href: "/alerts", label: "Alerts", icon: "notifications_active" },
  { href: "/settings", label: "Settings", icon: "settings" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
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

      {/* Profile */}
      <div className="mt-auto p-4 border-t border-outline-variant/10">
        <Link
          href="/profile"
          className="flex items-center gap-4 px-4 py-3 text-on-surface-variant/60 hover:bg-surface-container-high hover:text-on-surface-variant transition-colors rounded-lg"
        >
          <span className="material-symbols-outlined text-[20px]">
            account_circle
          </span>
          <span>Profile</span>
        </Link>
      </div>
    </aside>
  );
}
