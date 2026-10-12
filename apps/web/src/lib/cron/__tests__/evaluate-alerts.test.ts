import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/notifications", () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import {
  averageDurationMs,
  evaluateAlerts,
  failureRatePercent,
  isInCooldown,
  successRatePercent,
} from "../evaluate-alerts";
import { createNotification } from "@/lib/notifications";
import { createFakeSupabase, type RecordedQuery } from "../../__tests__/helpers/fake-supabase";

const NOW = new Date("2026-05-01T12:00:00Z");

describe("metric math", () => {
  it("computes success rate as a percentage, null without data", () => {
    expect(successRatePercent([{ status: "success" }, { status: "failed" }, { status: "success" }, { status: "timed_out" }])).toBe(50);
    expect(successRatePercent([])).toBeNull();
  });

  it("averages only known durations", () => {
    expect(averageDurationMs([{ duration_ms: 1000 }, { duration_ms: null }, { duration_ms: 3000 }])).toBe(2000);
    expect(averageDurationMs([{ duration_ms: null }])).toBeNull();
  });

  it("computes health-check failure rate", () => {
    expect(failureRatePercent([{ status: "fail" }, { status: "pass" }, { status: "pass" }, { status: "pass" }])).toBe(25);
    expect(failureRatePercent([])).toBeNull();
  });

  it("respects cooldowns", () => {
    expect(isInCooldown(null, 15, NOW)).toBe(false);
    expect(isInCooldown("2026-05-01T11:50:00Z", 15, NOW)).toBe(true);
    expect(isInCooldown("2026-05-01T11:40:00Z", 15, NOW)).toBe(false);
  });
});

describe("evaluateAlerts", () => {
  const rule = {
    id: "rule-1",
    org_id: "org-1",
    project_id: "proj-1",
    name: "Low success rate",
    metric: "success_rate",
    operator: "lt",
    threshold: 80,
    severity: "critical",
    cooldown_minutes: 15,
    last_triggered_at: null,
  };

  function resolver(runs: { status: string }[], claimWins = true) {
    return (q: RecordedQuery) => {
      if (q.table === "alert_rules" && q.operation === "select") return { data: [rule] };
      if (q.table === "pipeline_runs") return { data: runs };
      if (q.table === "alert_rules" && q.operation === "update") return { data: claimWins ? [{ id: "rule-1" }] : [] };
      return { data: [] };
    };
  }

  it("fires when the condition holds and notifies the org", async () => {
    vi.mocked(createNotification).mockClear();
    const { client, queries } = createFakeSupabase(resolver([{ status: "failed" }, { status: "success" }]));

    const result = await evaluateAlerts(client, NOW);

    expect(result).toEqual({ evaluated: 1, fired: 1, errors: [] });
    const stamp = queries.find((q) => q.table === "alert_rules" && q.operation === "update")!;
    expect(stamp.calls.some((c) => c.method === "is" && c.args[0] === "last_triggered_at")).toBe(true);
    expect(createNotification).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ org_id: "org-1", type: "alert_fired", user_id: null }),
    );
  });

  it("stays quiet when the condition does not hold", async () => {
    vi.mocked(createNotification).mockClear();
    const { client } = createFakeSupabase(resolver([{ status: "success" }]));
    const result = await evaluateAlerts(client, NOW);
    expect(result.fired).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("does not notify twice when a concurrent tick already stamped the rule", async () => {
    vi.mocked(createNotification).mockClear();
    const { client } = createFakeSupabase(resolver([{ status: "failed" }], false));
    const result = await evaluateAlerts(client, NOW);
    expect(result.fired).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("skips rules with no data in the window", async () => {
    const { client } = createFakeSupabase(resolver([]));
    const result = await evaluateAlerts(client, NOW);
    expect(result.fired).toBe(0);
  });
});
