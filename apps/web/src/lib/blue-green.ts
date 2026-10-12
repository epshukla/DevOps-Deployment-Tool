/**
 * Pure helpers for the blue-green deployment strategy UI.
 *
 * The runner never persists which color (blue/green) a revision used —
 * it's only a transient Docker label. We derive a stable, deterministic
 * color per revision from its revision_number so the UI can show an
 * "active" / "previous" color without needing a schema change.
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
