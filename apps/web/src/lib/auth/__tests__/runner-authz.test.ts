import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));

import { authorizeRunnerForDeployment, authorizeRunnerForRun } from "../runner";
import { createFakeSupabase, type RecordedQuery } from "../../__tests__/helpers/fake-supabase";

const runner = { id: "runner-a", org_id: "org-a" };

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    project_id: "proj-1",
    runner_id: "runner-a",
    status: "running",
    projects: { org_id: "org-a" },
    ...overrides,
  };
}

function fake(run: unknown, deployment?: unknown) {
  return createFakeSupabase((q: RecordedQuery) => {
    if (q.table === "pipeline_runs") return { data: run };
    if (q.table === "deployments") return { data: deployment ?? null };
    return { data: null };
  }).client;
}

describe("authorizeRunnerForRun", () => {
  it("allows the claiming runner of the same org", async () => {
    const result = await authorizeRunnerForRun(fake(runRow()), runner, "run-1", { requireClaimedBy: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ project_id: "proj-1", org_id: "org-a" });
  });

  it("hides runs from other orgs as 404 (no existence oracle)", async () => {
    const result = await authorizeRunnerForRun(
      fake(runRow({ projects: { org_id: "org-b" } })),
      runner,
      "run-1",
      { requireClaimedBy: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it("returns 404 for unknown runs", async () => {
    const result = await authorizeRunnerForRun(fake(null), runner, "nope", { requireClaimedBy: false });
    expect(!result.ok && result.response.status).toBe(404);
  });

  it("rejects a same-org runner that did not claim the run when required", async () => {
    const result = await authorizeRunnerForRun(
      fake(runRow({ runner_id: "runner-other" })),
      runner,
      "run-1",
      { requireClaimedBy: true },
    );
    expect(!result.ok && result.response.status).toBe(403);
  });

  it("lets a same-org runner read a run it did not claim when not required", async () => {
    const result = await authorizeRunnerForRun(
      fake(runRow({ runner_id: "runner-other" })),
      runner,
      "run-1",
      { requireClaimedBy: false },
    );
    expect(result.ok).toBe(true);
  });
});

describe("authorizeRunnerForDeployment", () => {
  it("allows a deployment of the run's project", async () => {
    const result = await authorizeRunnerForDeployment(
      fake(runRow(), { id: "dep-1", project_id: "proj-1" }),
      runner,
      "run-1",
      "dep-1",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a deployment belonging to a different project", async () => {
    const result = await authorizeRunnerForDeployment(
      fake(runRow(), { id: "dep-9", project_id: "proj-other" }),
      runner,
      "run-1",
      "dep-9",
    );
    expect(!result.ok && result.response.status).toBe(404);
  });

  it("rejects when the run is in another org", async () => {
    const result = await authorizeRunnerForDeployment(
      fake(runRow({ projects: { org_id: "org-b" } }), { id: "dep-1", project_id: "proj-1" }),
      runner,
      "run-1",
      "dep-1",
    );
    expect(!result.ok && result.response.status).toBe(404);
  });
});
