import { describe, it, expect } from "vitest";
import {
  colorForRevision,
  oppositeColor,
  isCutoverOrDrainEvent,
  colorsFromLatestCutover,
} from "../blue-green";

describe("colorForRevision", () => {
  it("returns blue for odd revision numbers", () => {
    expect(colorForRevision(1)).toBe("blue");
    expect(colorForRevision(3)).toBe("blue");
  });

  it("returns green for even revision numbers", () => {
    expect(colorForRevision(2)).toBe("green");
    expect(colorForRevision(4)).toBe("green");
  });

  it("alternates between consecutive revisions", () => {
    expect(colorForRevision(5)).not.toBe(colorForRevision(6));
  });
});

describe("oppositeColor", () => {
  it("flips blue to green and vice versa", () => {
    expect(oppositeColor("blue")).toBe("green");
    expect(oppositeColor("green")).toBe("blue");
  });
});

describe("isCutoverOrDrainEvent", () => {
  it("matches cutover event types", () => {
    expect(isCutoverOrDrainEvent("cutover_completed")).toBe(true);
    expect(isCutoverOrDrainEvent("blue_green_cutover")).toBe(true);
  });

  it("matches drain event types", () => {
    expect(isCutoverOrDrainEvent("drain_started")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isCutoverOrDrainEvent("CUTOVER")).toBe(true);
  });

  it("does not match unrelated event types", () => {
    expect(isCutoverOrDrainEvent("restart_started")).toBe(false);
    expect(isCutoverOrDrainEvent("canary_promotion")).toBe(false);
  });
});

describe("colorsFromLatestCutover", () => {
  it("uses the most recent cutover event's colors", () => {
    expect(
      colorsFromLatestCutover([
        { event_type: "blue_green_cutover", created_at: "2026-01-01T00:00:00Z", details: { from_color: "blue", to_color: "green" } },
        { event_type: "blue_green_cutover", created_at: "2026-01-02T00:00:00Z", details: { from_color: "green", to_color: "blue" } },
        { event_type: "health_degraded", created_at: "2026-01-03T00:00:00Z", details: {} },
      ]),
    ).toEqual({ active: "blue", previous: "green" });
  });

  it("returns null without a usable cutover event", () => {
    expect(colorsFromLatestCutover([])).toBeNull();
    expect(
      colorsFromLatestCutover([{ event_type: "blue_green_cutover", created_at: "x", details: { to_color: "purple" } }]),
    ).toBeNull();
  });
});
