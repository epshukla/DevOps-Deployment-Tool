/** Shared data shapes and styling for the Settings page client components. */

import { formatDateShort } from "@/lib/format-date";

export interface InviteData {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly invited_by: string;
  readonly expires_at: string;
  readonly created_at: string;
  /** Present only for admins/owners (they share the link). */
  readonly token: string | null;
  /** Computed server-side so server and client render agree. */
  readonly expired: boolean;
}

export interface MyInviteData {
  readonly id: string;
  readonly org_id: string;
  readonly org_name: string;
  readonly role: string;
  readonly expires_at: string;
  readonly created_at: string;
}

export const ROLE_BADGE: Readonly<Record<string, string>> = {
  owner: "bg-tertiary/10 text-tertiary border-tertiary/20",
  admin: "bg-primary/10 text-primary border-primary/20",
  developer: "bg-outline/10 text-on-surface-variant border-outline/20",
  viewer: "bg-outline/10 text-on-surface-variant/60 border-outline/10",
};

export const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "developer", label: "Developer" },
  { value: "admin", label: "Admin" },
] as const;

export function roleBadgeClass(role: string): string {
  return ROLE_BADGE[role] ?? ROLE_BADGE.viewer;
}

export function formatDate(dateStr: string): string {
  return formatDateShort(dateStr);
}
