/**
 * Pure helpers for the blue-green deployment strategy UI.
 *
 * The runner records a `blue_green_cutover` healing event with the real
 * from/to colors on every switch. Older deployments predate that event, so
 * we fall back to a deterministic color derived from revision_number.
 */

export type DeploymentColor = "blue" | "green";

/** Odd revisions are blue, even revisions are green (alternates every deploy). */
export function colorForRevision(revisionNumber: number): DeploymentColor {
  return revisionNumber % 2 === 1 ? "blue" : "green";
}

export function oppositeColor(color: DeploymentColor): DeploymentColor {
  return color === "blue" ? "green" : "blue";
}

/**
 * Healing events don't yet have a dedicated "cutover"/"drain" event_type
 * in the schema, but the runner may start emitting them. Match loosely so
 * the UI picks them up as soon as they appear without a code change.
 */
export function isCutoverOrDrainEvent(eventType: string): boolean {
  return /cutover|drain/i.test(eventType);
}

interface CutoverEventLike {
  readonly event_type: string;
  readonly created_at: string;
  readonly details?: Record<string, unknown> | null;
}

function asColor(value: unknown): DeploymentColor | null {
  return value === "blue" || value === "green" ? value : null;
}

/**
 * Colors from the most recent `blue_green_cutover` event, or null when no
 * such event exists (fall back to colorForRevision).
 */
export function colorsFromLatestCutover(
  events: readonly CutoverEventLike[],
): { readonly active: DeploymentColor; readonly previous: DeploymentColor | null } | null {
  const latest = [...events]
    .filter((e) => e.event_type === "blue_green_cutover")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const active = asColor(latest?.details?.to_color);
  if (!latest || !active) return null;
  return { active, previous: asColor(latest.details?.from_color) };
}
