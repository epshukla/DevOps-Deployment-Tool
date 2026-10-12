import { describe, it, expect, vi } from "vitest";
import { createNotification, notifyRunFinished } from "../notifications";
import { createFakeSupabase, type RecordedQuery } from "./helpers/fake-supabase";

describe("createNotification", () => {
  it("sends a personal notification to exactly one user", async () => {
    const { client, queries } = createFakeSupabase(() => ({ data: null }));

    await createNotification(client, {
      org_id: "org-1",
      user_id: "user-1",
      type: "pipeline_status",
      title: "t",
      body: "b",
    });

    const insert = queries.find((q) => q.operation === "insert")!;
    expect(insert.payload).toEqual([
      expect.objectContaining({ org_id: "org-1", user_id: "user-1", type: "pipeline_status" }),
    ]);
    expect(queries.some((q) => q.table === "org_memberships")).toBe(false);
  });

  it("fans a broadcast out to one row per org member (independent read state)", async () => {
    const { client, queries } = createFakeSupabase((q: RecordedQuery) =>
      q.table === "org_memberships"
        ? { data: [{ user_id: "a" }, { user_id: "b" }, { user_id: "c" }] }
        : { data: null },
    );

    await createNotification(client, {
      org_id: "org-1",
      user_id: null,
      type: "alert_fired",
      title: "t",
      body: "b",
      metadata: { href: "/alerts" },
    });

    const insert = queries.find((q) => q.operation === "insert")!;
    const rows = insert.payload as { user_id: string }[];
    expect(rows.map((r) => r.user_id)).toEqual(["a", "b", "c"]);
  });

  it("never throws when the insert fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = createFakeSupabase(() => ({ error: { message: "rls" } }));
    await expect(
      createNotification(client, { org_id: "o", user_id: "u", type: "system", title: "t", body: "b" }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("notifyRunFinished", () => {
  const run = {
    id: "run-1",
    project_id: "proj-1",
    created_by: "user-9",
    git_branch: "main",
    git_sha: "abcdef1234567",
    trigger_type: "webhook",
    projects: { name: "shop", org_id: "org-1" },
  };

  it("notifies the run's creator with a link to the run", async () => {
    const { client, queries } = createFakeSupabase((q) =>
      q.table === "pipeline_runs" ? { data: run } : { data: null },
    );

    await notifyRunFinished(client, "run-1", "failed");

    const insert = queries.find((q) => q.operation === "insert")!;
    expect(insert.payload).toEqual([
      expect.objectContaining({
        user_id: "user-9",
        title: "Pipeline failed: shop",
        body: "main @ abcdef1 · webhook",
        metadata: expect.objectContaining({ href: "/projects/proj-1/runs/run-1" }),
      }),
    ]);
  });

  it("stays silent for cancelled runs", async () => {
    const { client, queries } = createFakeSupabase(() => ({ data: run }));
    await notifyRunFinished(client, "run-1", "cancelled");
    expect(queries).toHaveLength(0);
  });
});
