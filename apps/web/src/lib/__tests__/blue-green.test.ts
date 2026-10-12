import { describe, it, expect } from "vitest";
import {
  colorForRevision,
  oppositeColor,
  isCutoverOrDrainEvent,
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
