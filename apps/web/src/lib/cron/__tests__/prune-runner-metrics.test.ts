import { describe, it, expect } from "vitest";
import { pruneRunnerMetrics } from "../prune-runner-metrics";
import { createFakeSupabase } from "../../__tests__/helpers/fake-supabase";

describe("pruneRunnerMetrics", () => {
  it("deletes samples older than 24 hours", async () => {
    const { client, queries } = createFakeSupabase(() => ({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }));

    const result = await pruneRunnerMetrics(client, new Date("2026-10-21T12:00:00Z"));

    expect(result).toEqual({ deleted: 3 });
    expect(queries[0].table).toBe("runner_metrics");
    expect(queries[0].operation).toBe("delete");
    expect(queries[0].calls).toContainEqual({ method: "lt", args: ["recorded_at", "2026-10-20T12:00:00.000Z"] });
  });

  it("reports errors without throwing", async () => {
    const { client } = createFakeSupabase(() => ({ error: { message: "nope" } }));
    expect(await pruneRunnerMetrics(client)).toEqual({ deleted: 0, error: "nope" });
  });
});
