import { describe, it, expect } from "vitest";
import { loadRunnerOptions } from "../runner-options";
import { createFakeSupabase, eqValue } from "./helpers/fake-supabase";

const NOW = new Date("2026-10-21T10:00:00Z");
const fresh = "2026-10-21T09:59:55Z";
const stale = "2026-10-21T09:00:00Z";

describe("loadRunnerOptions", () => {
  it("lists the org's runners, available first, with heartbeat-derived status", async () => {
    const { client, queries } = createFakeSupabase(() => ({
      data: [
        { id: "r1", name: "zeta", status: "online", last_heartbeat_at: stale },
        { id: "r2", name: "beta", status: "busy", last_heartbeat_at: fresh },
        { id: "r3", name: "alpha", status: "online", last_heartbeat_at: fresh },
      ],
    }));

    const options = await loadRunnerOptions(client, "org-1", NOW);

    expect(eqValue(queries[0], "org_id")).toBe("org-1");
    expect(options).toEqual([
      { id: "r3", name: "alpha", status: "online" },
      { id: "r2", name: "beta", status: "busy" },
      { id: "r1", name: "zeta", status: "offline" },
    ]);
  });

  it("is empty when the query fails", async () => {
    const { client } = createFakeSupabase(() => ({ error: { message: "nope" } }));
    expect(await loadRunnerOptions(client, "org-1", NOW)).toEqual([]);
  });
});
