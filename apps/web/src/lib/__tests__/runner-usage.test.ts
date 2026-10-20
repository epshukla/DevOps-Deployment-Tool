import { describe, it, expect } from "vitest";
import { usageLevel, percentOf, isMetricsFresh, summarizeRunnerJobs } from "../runner-usage";

const NOW = new Date("2026-10-21T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("usageLevel", () => {
  it.each([
    [10, "ok"],
    [79.9, "ok"],
    [80, "warn"],
    [89.9, "warn"],
    [90, "critical"],
    [null, "unknown"],
  ] as const)("%s%% → %s", (pct, level) => {
    expect(usageLevel(pct)).toBe(level);
  });
});

describe("percentOf", () => {
  it("is the rounded share, or null when the total is unknown", () => {
    expect(percentOf(13_225, 15_700)).toBe(84.2);
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(null, 100)).toBeNull();
  });
});

describe("isMetricsFresh", () => {
  it("is fresh within three sampling intervals", () => {
    expect(isMetricsFresh(new Date(NOW.getTime() - 60_000).toISOString(), NOW)).toBe(true);
    expect(isMetricsFresh(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe(false);
    expect(isMetricsFresh(null, NOW)).toBe(false);
  });
});

describe("summarizeRunnerJobs", () => {
  it("counts jobs, outcomes and the share of the window spent running them", () => {
    const summary = summarizeRunnerJobs(
      [
        { runner_id: "r1", status: "success", started_at: hoursAgo(3), finished_at: hoursAgo(2), duration_ms: 3_600_000 },
        { runner_id: "r1", status: "failed", started_at: hoursAgo(1), finished_at: hoursAgo(0.5), duration_ms: 1_800_000 },
        // still running: counts up to now
        { runner_id: "r1", status: "running", started_at: hoursAgo(1.5), finished_at: null, duration_ms: null },
        { runner_id: "r2", status: "success", started_at: hoursAgo(30), finished_at: hoursAgo(29), duration_ms: 3_600_000 },
      ],
      NOW,
      24,
    );

    expect(summary.get("r1")).toEqual({
      jobs: 3,
      succeeded: 1,
      failed: 1,
      running: 1,
      busyPercent: 12.5, // 1h + 0.5h + 1.5h of 24h
      avgDurationMs: 2_700_000,
    });
    // r2's only job was outside the 24h window
    expect(summary.get("r2")).toBeUndefined();
  });

  it("clips jobs that started before the window", () => {
    const summary = summarizeRunnerJobs(
      [{ runner_id: "r1", status: "success", started_at: hoursAgo(25), finished_at: hoursAgo(23), duration_ms: 7_200_000 }],
      NOW,
      24,
    );
    expect(summary.get("r1")?.busyPercent).toBeCloseTo(4.2, 1); // only the last hour counts
  });
});
