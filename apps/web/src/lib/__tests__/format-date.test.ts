import { describe, it, expect } from "vitest";
import { DISPLAY_TIME_ZONE, formatDate, formatTime } from "../format-date";

// The server renders in UTC and the browser in the viewer's zone; output must
// not depend on either, or hydration mismatches (React #418).
describe("format-date display zone", () => {
  const instant = "2026-10-19T18:45:44.000Z"; // 00:15:44 the next day in IST

  it("defaults to India time", () => {
    expect(DISPLAY_TIME_ZONE).toBe("Asia/Kolkata");
  });

  it("formats in the display zone, not the process zone", () => {
    expect(formatDate(instant)).toBe("Oct 20, 2026, 12:15 AM");
    expect(formatTime(instant)).toBe("12:15:44 AM");
  });
});
