/**
 * Trend math — pure helpers for comparing a "current window" metric
 * against a "previous window" metric (e.g. last 7 days vs. prior 7 days)
 * for display in StatCard's `trend` prop.
 */

export interface Trend {
  readonly direction: "up" | "down";
  readonly value: string;
}

/**
 * Compute a percentage-change trend between two numeric values.
 *
 * Returns `undefined` when there isn't enough signal to show a
 * meaningful trend (both values are zero/empty).
 */
export function computeTrend(
  current: number,
  previous: number,
): Trend | undefined {
  if (current === 0 && previous === 0) {
    return undefined;
  }

  if (previous === 0) {
    return { direction: "up", value: "New" };
  }

  const percentChange = ((current - previous) / previous) * 100;
  const direction: "up" | "down" = percentChange >= 0 ? "up" : "down";
  const rounded = Math.round(Math.abs(percentChange));

  return {
    direction,
    value: `${direction === "up" ? "+" : "-"}${rounded}%`,
  };
}

/**
 * Partition timestamped records into a "current" window (the last
 * `windowDays` days) and a "previous" window (the `windowDays` days
 * before that), relative to `now`.
 */
export function splitByWindow<T extends { readonly created_at: string }>(
  records: readonly T[],
  windowDays: number,
  now: Date = new Date(),
): { readonly current: readonly T[]; readonly previous: readonly T[] } {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const currentStart = now.getTime() - windowMs;
  const previousStart = currentStart - windowMs;

  const current: T[] = [];
  const previous: T[] = [];

  for (const record of records) {
    const ts = new Date(record.created_at).getTime();
    if (ts >= currentStart) {
      current.push(record);
    } else if (ts >= previousStart) {
      previous.push(record);
    }
  }

  return { current, previous };
}
