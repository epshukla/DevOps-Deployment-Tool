import { describe, it, expect } from "vitest";
import { formatDurationShort, formatRelative } from "../format-date";

const NOW = new Date("2026-10-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("formatRelative", () => {
  it("buckets recent times compactly", () => {
    expect(formatRelative(ago(10_000), NOW)).toBe("just now");
    expect(formatRelative(ago(12 * 60_000), NOW)).toBe("12m ago");
    expect(formatRelative(ago(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(formatRelative(ago(5 * 86_400_000), NOW)).toBe("5d ago");
  });

  it("falls back to a date after a month", () => {
    expect(formatRelative(ago(60 * 86_400_000), NOW)).not.toMatch(/ago/);
  });
});

describe("formatDurationShort", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDurationShort(52_400)).toBe("52.4s");
    expect(formatDurationShort(185_000)).toBe("3m 05s");
    expect(formatDurationShort(3_720_000)).toBe("1h 02m");
    expect(formatDurationShort(null)).toBe("—");
  });
});
