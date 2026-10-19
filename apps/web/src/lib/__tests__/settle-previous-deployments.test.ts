import { describe, it, expect } from "vitest";
import { settlePreviousDeployments } from "../settle-previous-deployments";
import { createFakeSupabase, eqValue } from "./helpers/fake-supabase";

const PROJECT = "p1";
const CURRENT = "d-new";

describe("settlePreviousDeployments", () => {
  it("stops draining deployments once the new one is active", async () => {
    const { client, queries } = createFakeSupabase(() => ({ data: [{ id: "d-old" }] }));

    const result = await settlePreviousDeployments(client, PROJECT, CURRENT, "active");

    expect(result).toEqual({ stopped: 1, restored: null });
    const q = queries[0];
    expect(q.operation).toBe("update");
    expect(q.payload).toMatchObject({ status: "stopped", public_url: null, public_url_expires_at: null });
    expect(eqValue(q, "project_id")).toBe(PROJECT);
    expect(eqValue(q, "status")).toBe("draining");
    expect(q.calls).toContainEqual({ method: "neq", args: ["id", CURRENT] });
  });

  it.each(["failed", "rolled_back"] as const)(
    "restores the most recent draining deployment when the new one is %s",
    async (status) => {
      const { client, queries } = createFakeSupabase((q) =>
        q.operation === "select" ? { data: { id: "d-old" } } : { data: [] },
      );

      const result = await settlePreviousDeployments(client, PROJECT, CURRENT, status);

      expect(result).toEqual({ stopped: 0, restored: "d-old" });
      const [lookup, restore] = queries;
      expect(lookup.calls).toContainEqual({ method: "order", args: ["created_at", { ascending: false }] });
      expect(restore.operation).toBe("update");
      expect(restore.payload).toMatchObject({ status: "active" });
      expect(eqValue(restore, "id")).toBe("d-old");
    },
  );

  it("does nothing when there is no previous deployment to restore", async () => {
    const { client, queries } = createFakeSupabase(() => ({ data: null }));
    expect(await settlePreviousDeployments(client, PROJECT, CURRENT, "failed")).toEqual({
      stopped: 0,
      restored: null,
    });
    expect(queries).toHaveLength(1);
  });

  it("ignores statuses that don't settle a hand-over", async () => {
    const { client, queries } = createFakeSupabase(() => ({ data: [] }));
    expect(await settlePreviousDeployments(client, PROJECT, CURRENT, "deploying")).toEqual({
      stopped: 0,
      restored: null,
    });
    expect(queries).toHaveLength(0);
  });

  it("reports errors without throwing", async () => {
    const { client } = createFakeSupabase(() => ({ error: { message: "nope" } }));
    expect(await settlePreviousDeployments(client, PROJECT, CURRENT, "active")).toEqual({
      stopped: 0,
      restored: null,
      error: "nope",
    });
  });
});
