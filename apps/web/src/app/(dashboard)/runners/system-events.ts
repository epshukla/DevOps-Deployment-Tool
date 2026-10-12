/**
 * Builds the "Recent System Events" feed for the runners page by merging
 * runner-related audit events with synthetic "registered" events derived
 * from each runner's created_at timestamp.
 */

export interface AuditEventRow {
  readonly id: string;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly details: Record<string, unknown> | null;
  readonly created_at: string;
}

export interface RunnerRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

export interface SystemEvent {
  readonly id: string;
  readonly kind: "audit" | "registered";
  readonly icon: string;
  readonly label: string;
  readonly timestamp: string;
}

const RUNNER_RESOURCE_TYPES = new Set(["runner", "runner_registration"]);

export function isRunnerAuditEvent(event: { readonly resource_type: string }): boolean {
  return RUNNER_RESOURCE_TYPES.has(event.resource_type);
}

function describeAuditEvent(event: AuditEventRow): { icon: string; label: string } {
  const name = (event.details?.name as string | undefined) ?? event.resource_id;

  if (event.action === "create") {
    return { icon: "vpn_key", label: `Registration token generated for "${name}"` };
  }

  if (event.action === "delete") {
    const forced = Boolean(event.details?.forced);
    return {
      icon: forced ? "warning" : "delete",
      label: forced ? `Runner "${name}" force-revoked` : `Runner "${name}" revoked`,
    };
  }

  return { icon: "info", label: `${event.action} on runner "${name}"` };
}

/**
 * Merge runner-related audit events with synthetic registration events,
 * sorted newest-first and capped at `limit`.
 */
export function buildRunnerSystemEvents(
  auditEvents: readonly AuditEventRow[],
  runners: readonly RunnerRow[],
  limit = 15,
): readonly SystemEvent[] {
  const fromAudit: SystemEvent[] = auditEvents.filter(isRunnerAuditEvent).map((event) => {
    const { icon, label } = describeAuditEvent(event);
    return {
      id: `audit:${event.id}`,
      kind: "audit",
      icon,
      label,
      timestamp: event.created_at,
    };
  });

  const fromRegistrations: SystemEvent[] = runners.map((runner) => ({
    id: `registered:${runner.id}`,
    kind: "registered",
    icon: "memory",
    label: `Runner "${runner.name}" registered`,
    timestamp: runner.created_at,
  }));

  return [...fromAudit, ...fromRegistrations]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}
