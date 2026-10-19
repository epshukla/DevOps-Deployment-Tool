import { describe, it, expect } from "vitest";
import { timeLeft } from "../public-url-link";

const NOW = Date.parse("2026-10-20T10:00:00Z");

describe("timeLeft", () => {
  it("counts down in hours, then minutes", () => {
    expect(timeLeft("2026-10-21T09:30:00Z", NOW)).toBe("23h left");
    expect(timeLeft("2026-10-20T10:20:00Z", NOW)).toBe("20m left");
    expect(timeLeft("2026-10-20T10:00:20Z", NOW)).toBe("1m left");
  });

  it("returns null once expired or invalid", () => {
    expect(timeLeft("2026-10-20T09:59:00Z", NOW)).toBeNull();
    expect(timeLeft("garbage", NOW)).toBeNull();
  });
});
