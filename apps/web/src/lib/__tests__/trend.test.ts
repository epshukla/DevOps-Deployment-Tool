import { describe, it, expect } from "vitest";
import { computeTrend, splitByWindow } from "../trend";

describe("computeTrend", () => {
  it("returns undefined when both values are zero", () => {
    expect(computeTrend(0, 0)).toBeUndefined();
  });

  it("returns an 'up' trend with a 'New' label when previous is zero but current is not", () => {
    expect(computeTrend(5, 0)).toEqual({ direction: "up", value: "New" });
  });

  it("computes a positive percentage change as 'up'", () => {
    expect(computeTrend(120, 100)).toEqual({ direction: "up", value: "+20%" });
  });

  it("computes a negative percentage change as 'down'", () => {
    expect(computeTrend(80, 100)).toEqual({ direction: "down", value: "-20%" });
  });

  it("treats no change as 'up' with 0%", () => {
    expect(computeTrend(100, 100)).toEqual({ direction: "up", value: "+0%" });
  });

  it("rounds fractional percentage changes", () => {
    expect(computeTrend(103, 100)).toEqual({ direction: "up", value: "+3%" });
  });
});

describe("splitByWindow", () => {
  const now = new Date("2026-10-12T00:00:00.000Z");

  function daysAgo(days: number): string {
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  it("splits records into current and previous windows", () => {
    const records = [
      { id: "a", created_at: daysAgo(1) }, // current
      { id: "b", created_at: daysAgo(6) }, // current
      { id: "c", created_at: daysAgo(8) }, // previous
      { id: "d", created_at: daysAgo(13) }, // previous
      { id: "e", created_at: daysAgo(20) }, // out of range
    ];

    const { current, previous } = splitByWindow(records, 7, now);

    expect(current.map((r) => r.id)).toEqual(["a", "b"]);
    expect(previous.map((r) => r.id)).toEqual(["c", "d"]);
  });

  it("returns empty arrays when there are no records", () => {
    const { current, previous } = splitByWindow([], 7, now);
    expect(current).toEqual([]);
    expect(previous).toEqual([]);
  });
});
