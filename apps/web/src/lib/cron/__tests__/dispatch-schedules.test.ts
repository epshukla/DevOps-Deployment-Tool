import { describe, it, expect } from "vitest";
import { dispatchDueSchedules } from "../dispatch-schedules";
import { createFakeSupabase, eqValue, type RecordedQuery } from "../../__tests__/helpers/fake-supabase";

const NOW = new Date("2026-05-01T10:00:30Z");

const dueSchedule = {
  id: "sched-1",
  project_id: "proj-1",
  pipeline_definition_id: "def-1",
  cron_expression: "*/5 * * * *",
  timezone: "UTC",
  git_branch: "main",
  next_run_at: "2026-05-01T10:00:00.000Z",
  created_by: "user-1",
};

function resolver(options: { claimWins: boolean }) {
  return (q: RecordedQuery) => {
    if (q.table === "pipeline_schedules" && q.operation === "select") {
      return { data: [dueSchedule] };
    }
    if (q.table === "pipeline_schedules" && q.operation === "update" && eqValue(q, "next_run_at")) {
      return { data: options.claimWins ? [{ id: "sched-1" }] : [] };
    }
    if (q.table === "pipeline_definitions") {
      return { data: { id: "def-1", current_version_id: "ver-3" } };
    }
    if (q.table === "pipeline_runs" && q.operation === "insert") {
      return { data: { id: "run-9" } };
    }
    return { data: null };
  };
}

describe("dispatchDueSchedules", () => {
  it("claims the slot with a compare-and-swap on next_run_at, then queues a run", async () => {
    const { client, queries } = createFakeSupabase(resolver({ claimWins: true }));

    const result = await dispatchDueSchedules(client, NOW);

    expect(result).toEqual({ due: 1, dispatched: 1, skipped: 0, errors: [] });

    const claim = queries.find((q) => q.table === "pipeline_schedules" && q.operation === "update" && eqValue(q, "next_run_at"));
    expect(eqValue(claim!, "next_run_at")).toBe(dueSchedule.next_run_at);
    expect((claim!.payload as { next_run_at: string }).next_run_at).toBe("2026-05-01T10:05:00.000Z");

    const insert = queries.find((q) => q.table === "pipeline_runs" && q.operation === "insert");
    expect(insert!.payload).toMatchObject({
      status: "queued",
      trigger_type: "schedule",
      pipeline_version_id: "ver-3",
      git_branch: "main",
    });
  });

  it("does not create a run when another invocation already claimed the slot", async () => {
    const { client, queries } = createFakeSupabase(resolver({ claimWins: false }));

    const result = await dispatchDueSchedules(client, NOW);

    expect(result).toEqual({ due: 1, dispatched: 0, skipped: 1, errors: [] });
    expect(queries.some((q) => q.table === "pipeline_runs")).toBe(false);
  });

  it("uses the schedule's time zone for the next slot", async () => {
    const { client, queries } = createFakeSupabase((q) => {
      if (q.table === "pipeline_schedules" && q.operation === "select") {
        return { data: [{ ...dueSchedule, cron_expression: "0 9 * * *", timezone: "Asia/Kolkata" }] };
      }
      return resolver({ claimWins: true })(q);
    });

    await dispatchDueSchedules(client, NOW);

    const claim = queries.find((q) => q.operation === "update" && eqValue(q, "next_run_at"));
    // 09:00 IST on May 2 = 03:30 UTC
    expect((claim!.payload as { next_run_at: string }).next_run_at).toBe("2026-05-02T03:30:00.000Z");
  });

  it("reports a fetch error without throwing", async () => {
    const { client } = createFakeSupabase(() => ({ error: { message: "boom" } }));
    const result = await dispatchDueSchedules(client, NOW);
    expect(result.errors).toEqual(["fetch: boom"]);
  });
});
