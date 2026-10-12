import { HEARTBEAT_INTERVAL_MS } from "@deployx/shared";

/**
 * A runner is considered offline once its last heartbeat is older than
 * this threshold, regardless of what the stored `status` column says.
 * The stored column is written by the runner itself and never updated
 * if the process dies, so it can go stale indefinitely without this check.
 */
export const RUNNER_OFFLINE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3;

export type RunnerDisplayStatus = "online" | "busy" | "offline";

/**
 * Derive the status to display for a runner from heartbeat freshness,
 * falling back to the stored status only when the heartbeat is fresh.
 */
export function getRunnerDisplayStatus(
  storedStatus: string,
  lastHeartbeatAt: string | null,
  now: Date = new Date(),
): RunnerDisplayStatus {
  if (!lastHeartbeatAt) return "offline";

  const age = now.getTime() - new Date(lastHeartbeatAt).getTime();
  if (age > RUNNER_OFFLINE_THRESHOLD_MS) return "offline";

  return storedStatus === "busy" ? "busy" : "online";
}

/**
 * Format a human-readable "last seen" string, e.g. "12s ago", "4m ago".
 */
export function formatLastSeen(
  lastHeartbeatAt: string | null,
  now: Date = new Date(),
): string {
  if (!lastHeartbeatAt) return "never";

  const diffMs = now.getTime() - new Date(lastHeartbeatAt).getTime();
  if (diffMs < 5_000) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
