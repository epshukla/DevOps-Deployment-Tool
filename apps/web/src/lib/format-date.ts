const LOCALE = "en-US" as const;

/**
 * Times are rendered on the server (Vercel runs in UTC) and again in the
 * browser during hydration. Without a fixed zone the two disagree, React
 * throws a hydration error (#418) and server pages show UTC. One explicit
 * display zone keeps both sides identical.
 */
export const DISPLAY_TIME_ZONE =
  process.env.NEXT_PUBLIC_DISPLAY_TIME_ZONE || "Asia/Kolkata";

const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const dateOnlyFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
});

const timeOnlyFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** Format as "Apr 12, 2026, 2:18 PM" */
export function formatDate(date: string | Date): string {
  return dateTimeFmt.format(new Date(date));
}

/** Format as "Apr 12, 2026" */
export function formatDateShort(date: string | Date): string {
  return dateOnlyFmt.format(new Date(date));
}

/** Format as "2:18:22 PM" */
export function formatTime(date: string | Date): string {
  return timeOnlyFmt.format(new Date(date));
}

/**
 * Compact relative time for dense tables: "just now", "12m ago", "3h ago",
 * "5d ago", then a short date. Time-zone independent.
 */
export function formatRelative(date: string | Date, now: Date = new Date()): string {
  const then = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDateShort(then);
}

/** "52.4s", "3m 05s", "1h 02m" from milliseconds. */
export function formatDurationShort(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
