import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/notifications", () => ({
  notifyRunFinished: vi.fn().mockResolvedValue(undefined),
}));

import { isRunOrphaned, reapOrphans, RUNNER_STALE_AFTER_MS } from "../reap-orphans";
import { notifyRunFinished } from "@/lib/notifications";
import { createFakeSupabase, eqValue } from "../../__tests__/helpers/fake-supabase";

const NOW = new Date("2026-05-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const OPTS = { staleAfterMs: 30_000, graceMs: 90_000 };

describe("isRunOrphaned", () => {
  const run = { id: "r1", runner_id: "rn1", updated_at: ago(10 * 60_000), started_at: ago(10 * 60_000) };

  it("keeps runs whose runner is still heartbeating", () => {
    expect(isRunOrphaned(run, { id: "rn1", last_heartbeat_at: ago(5_000), current_job_id: "r1" }, NOW, OPTS)).toBe(false);
  });

  it("orphans runs whose runner went silent past threshold + grace", () => {
    expect(isRunOrphaned(run, { id: "rn1", last_heartbeat_at: ago(5 * 60_000), current_job_id: "r1" }, NOW, OPTS)).toBe(true);
  });

  it("orphans runs whose runner was deleted", () => {
    expect(isRunOrphaned(run, undefined, NOW, OPTS)).toBe(true);
  });

  it("gives recently-active runs a grace period even if the runner blipped", () => {
    const fresh = { ...run, updated_at: ago(20_000) };
    expect(isRunOrphaned(fresh, { id: "rn1", last_heartbeat_at: ago(5 * 60_000), current_job_id: "r1" }, NOW, OPTS)).toBe(false);
  });

  it("does not orphan a run during a short heartbeat gap", () => {
    expect(isRunOrphaned(run, { id: "rn1", last_heartbeat_at: ago(60_000), current_job_id: "r1" }, NOW, OPTS)).toBe(false);
  });
});

describe("reapOrphans", () => {
  it("marks stale runners offline and times out orphaned runs conditionally", async () => {
    const { client, queries } = createFakeSupabase((q) => {
      if (q.table === "runner_registrations" && q.operation === "update" && !eqValue(q, "id")) {
        return { data: [{ id: "dead-runner" }] };
      }
      if (q.table === "pipeline_runs" && q.operation === "select") {
        return { data: [{ id: "run-1", runner_id: "dead-runner", updated_at: ago(10 * 60_000), started_at: ago(10 * 60_000) }] };
      }
      if (q.table === "runner_registrations" && q.operation === "select") {
        return { data: [{ id: "dead-runner", last_heartbeat_at: ago(10 * 60_000), current_job_id: "run-1" }] };
      }
      if (q.table === "pipeline_runs" && q.operation === "update") return { data: [{ id: "run-1" }] };
      if (q.table === "task_runs" && q.operation === "select") return { data: [{ id: "task-1" }] };
      return { data: null };
    });

    const result = await reapOrphans(client, NOW);

    expect(result).toEqual({ runnersMarkedOffline: 1, runsTimedOut: 1, errors: [] });

    const timeout = queries.find((q) => q.table === "pipeline_runs" && q.operation === "update")!;
    expect(timeout.payload).toMatchObject({ status: "timed_out" });
    expect(eqValue(timeout, "status")).toBe("running"); // conditional on what we read

    const release = queries.find((q) => q.table === "runner_registrations" && q.operation === "update" && eqValue(q, "id") === "dead-runner")!;
    expect(eqValue(release, "current_job_id")).toBe("run-1");

    expect(queries.some((q) => q.table === "run_logs" && q.operation === "insert")).toBe(true);
    expect(notifyRunFinished).toHaveBeenCalledWith(client, "run-1", "timed_out");
  });

  it("skips runs that finished between read and update", async () => {
    const { client } = createFakeSupabase((q) => {
      if (q.table === "pipeline_runs" && q.operation === "select") {
        return { data: [{ id: "run-1", runner_id: null, updated_at: ago(10 * 60_000), started_at: null }] };
      }
      if (q.table === "pipeline_runs" && q.operation === "update") return { data: [] };
      return { data: [] };
    });

    const result = await reapOrphans(client, NOW);
    expect(result.runsTimedOut).toBe(0);
  });

  it("uses 3 missed heartbeats as the stale threshold", () => {
    expect(RUNNER_STALE_AFTER_MS).toBe(30_000);
  });
});
