import { hasMinRole } from "@deployx/shared";

/**
 * What the current user may do in the active org, for the UI. The server
 * actions and RLS enforce the same rules; this only decides what to grey out.
 */
export interface Permissions {
  readonly role: string;
  /** developer+: run pipelines, edit pipelines/secrets/webhooks/schedules, deploy */
  readonly canEdit: boolean;
  /** admin+: runners, alerts, members, artifact deletion */
  readonly canAdmin: boolean;
  readonly isOwner: boolean;
  /** Tooltip for disabled controls; undefined when the user can edit */
  readonly readOnlyReason?: string;
}

/** The caller's role in the active org; "viewer" when it can't be determined. */
export function activeRole(
  orgs: ReadonlyArray<{ readonly id: string; readonly role: string }>,
  activeOrgId: string | null,
): string {
  const org = activeOrgId ? orgs.find((o) => o.id === activeOrgId) : orgs[0];
  return org?.role ?? "viewer";
}

export function permissionsFor(role: string): Permissions {
  const canEdit = hasMinRole(role, "developer");
  return {
    role,
    canEdit,
    canAdmin: hasMinRole(role, "admin"),
    isOwner: role === "owner",
    readOnlyReason: canEdit ? undefined : "You have the viewer role — read-only access",
  };
}
