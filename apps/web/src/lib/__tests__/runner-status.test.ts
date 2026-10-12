import { describe, it, expect } from "vitest";
import {
  getRunnerDisplayStatus,
  formatLastSeen,
  RUNNER_OFFLINE_THRESHOLD_MS,
} from "../runner-status";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function msAgo(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("RUNNER_OFFLINE_THRESHOLD_MS", () => {
  it("is 3x the heartbeat interval (30s)", () => {
    expect(RUNNER_OFFLINE_THRESHOLD_MS).toBe(30_000);
  });
});

describe("getRunnerDisplayStatus", () => {
  it("returns offline when there is no heartbeat at all", () => {
    expect(getRunnerDisplayStatus("online", null, NOW)).toBe("offline");
  });

  it("returns offline when the heartbeat is older than the threshold", () => {
    expect(
      getRunnerDisplayStatus("online", msAgo(RUNNER_OFFLINE_THRESHOLD_MS + 1), NOW),
    ).toBe("offline");
  });

  it("returns offline even if the stored status says online or busy", () => {
    expect(
      getRunnerDisplayStatus("busy", msAgo(RUNNER_OFFLINE_THRESHOLD_MS + 1), NOW),
    ).toBe("offline");
  });

  it("returns the stored status when the heartbeat is fresh", () => {
    expect(getRunnerDisplayStatus("online", msAgo(1_000), NOW)).toBe("online");
    expect(getRunnerDisplayStatus("busy", msAgo(1_000), NOW)).toBe("busy");
  });

  it("treats a stored status of anything other than busy as online when fresh", () => {
    expect(getRunnerDisplayStatus("offline", msAgo(1_000), NOW)).toBe("online");
  });

  it("is exactly at the threshold boundary (inclusive) still fresh", () => {
    expect(
      getRunnerDisplayStatus("online", msAgo(RUNNER_OFFLINE_THRESHOLD_MS), NOW),
    ).toBe("online");
  });
});

describe("formatLastSeen", () => {
  it("returns 'never' when there is no heartbeat", () => {
    expect(formatLastSeen(null, NOW)).toBe("never");
  });

  it("returns 'just now' for very recent heartbeats", () => {
    expect(formatLastSeen(msAgo(1_000), NOW)).toBe("just now");
  });

  it("formats seconds", () => {
    expect(formatLastSeen(msAgo(42_000), NOW)).toBe("42s ago");
  });

  it("formats minutes", () => {
    expect(formatLastSeen(msAgo(5 * 60_000), NOW)).toBe("5m ago");
  });

  it("formats hours", () => {
    expect(formatLastSeen(msAgo(3 * 60 * 60_000), NOW)).toBe("3h ago");
  });

  it("formats days", () => {
    expect(formatLastSeen(msAgo(2 * 24 * 60 * 60_000), NOW)).toBe("2d ago");
  });
});
