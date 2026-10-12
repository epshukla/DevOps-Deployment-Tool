import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────

const { mockSupabase, mockUser, mockOrg, mockRequireUserWithOrg } = vi.hoisted(() => ({
  mockSupabase: { from: vi.fn() },
  mockUser: { id: "user-1" },
  mockOrg: { id: "org-1" },
  mockRequireUserWithOrg: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  requireUserWithOrg: mockRequireUserWithOrg,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { stopDeployment, rollbackDeployment } from "../actions";
import { recordAuditEvent } from "@/lib/audit";

// ── Chain helpers ────────────────────────────────────────────────

interface SelectChain {
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
}

/** Builds `.select(...).eq(...).eq(...)...single()` resolving to `result`. */
function selectSingleChain(result: { data: unknown; error?: unknown }) {
  const chain = {} as SelectChain;
  chain.single = vi.fn().mockResolvedValue(result);
  chain.eq = vi.fn().mockReturnValue(chain);
  return vi.fn().mockReturnValue(chain);
}

interface UpdateChain {
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  then: (resolve: (value: unknown) => unknown) => void;
}

/**
 * Builds `.update(...).eq(...).eq(...)` that resolves to `awaitResult` when
 * awaited directly, and `.select(...)` that resolves to `selectResult` when
 * a `.select()` call terminates the chain instead.
 */
function updateChain(
  awaitResult: { error: unknown } = { error: null },
  selectResult?: { data: unknown; error: unknown },
) {
  const chain = {} as UpdateChain;
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.neq = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockResolvedValue(selectResult ?? { data: [{ id: "x" }], error: null });
  chain.then = (resolve: (value: unknown) => unknown) => resolve(awaitResult);
  return vi.fn().mockReturnValue(chain);
}

// ── Tests ──────────────────────────────────────────────────────

describe("stopDeployment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUserWithOrg.mockResolvedValue({
      supabase: mockSupabase,
      user: mockUser,
      org: mockOrg,
      role: "developer",
    });
  });

  it("rejects callers below developer role", async () => {
    mockRequireUserWithOrg.mockResolvedValue({
      supabase: mockSupabase,
      user: mockUser,
      org: mockOrg,
      role: "viewer",
    });

    const result = await stopDeployment("proj-1", "dep-1");

    expect(result).toEqual({ error: "You don't have permission to stop deployments" });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("returns an error when the deployment is not found", async () => {
    mockSupabase.from.mockReturnValue({
      select: selectSingleChain({ data: null }),
    });

    const result = await stopDeployment("proj-1", "dep-1");

    expect(result).toEqual({ error: "Deployment not found" });
  });

  it("refuses to stop an already-terminal deployment", async () => {
    mockSupabase.from.mockReturnValue({
      select: selectSingleChain({ data: { id: "dep-1", status: "stopped" } }),
    });

    const result = await stopDeployment("proj-1", "dep-1");

    expect(result).toEqual({ error: "Deployment is already stopped" });
  });

  it("reports not found/not permitted when the update affects no rows", async () => {
    const select = selectSingleChain({ data: { id: "dep-1", status: "active" } });
    const update = updateChain({ error: null }, { data: [], error: null });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "deployments") return { select, update };
      return { update: updateChain() };
    });

    const result = await stopDeployment("proj-1", "dep-1");

    expect(result).toEqual({ error: "Deployment not found or not permitted" });
  });

  it("stops an active deployment, logs an audit event, and revalidates", async () => {
    const select = selectSingleChain({ data: { id: "dep-1", status: "active" } });
    const deploymentsUpdate = updateChain({ error: null }, { data: [{ id: "dep-1" }], error: null });
    const revisionsUpdate = updateChain({ error: null });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "deployments") return { select, update: deploymentsUpdate };
      if (table === "deployment_revisions") return { update: revisionsUpdate };
      throw new Error(`unexpected table ${table}`);
    });

    const result = await stopDeployment("proj-1", "dep-1");

    expect(result).toEqual({ success: true });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        org_id: mockOrg.id,
        user_id: mockUser.id,
        action: "update",
        resource_type: "deployment",
        resource_id: "dep-1",
      }),
    );
  });
});

describe("rollbackDeployment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUserWithOrg.mockResolvedValue({
      supabase: mockSupabase,
      user: mockUser,
      org: mockOrg,
      role: "developer",
    });
  });

  it("rejects callers below developer role", async () => {
    mockRequireUserWithOrg.mockResolvedValue({
      supabase: mockSupabase,
      user: mockUser,
      org: mockOrg,
      role: "viewer",
    });

    const result = await rollbackDeployment("proj-1", "dep-1", "rev-1", "bad build");

    expect(result).toEqual({ error: "You don't have permission to rollback deployments" });
  });

  it("requires a non-empty reason", async () => {
    const result = await rollbackDeployment("proj-1", "dep-1", "rev-1", "   ");

    expect(result).toEqual({ error: "A rollback reason is required" });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("returns an error when the deployment is not found", async () => {
    mockSupabase.from.mockReturnValue({
      select: selectSingleChain({ data: null }),
    });

    const result = await rollbackDeployment("proj-1", "dep-1", "rev-1", "bad build");

    expect(result).toEqual({ error: "Deployment not found" });
  });

  it("refuses to rollback a deployment that isn't active or draining", async () => {
    mockSupabase.from.mockReturnValue({
      select: selectSingleChain({ data: { id: "dep-1", status: "stopped" } }),
    });

    const result = await rollbackDeployment("proj-1", "dep-1", "rev-1", "bad build");

    expect(result).toEqual({ error: "Cannot rollback deployment in stopped state" });
  });

  it("rejects a target revision that doesn't belong to this deployment", async () => {
    let call = 0;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "deployments") {
        return { select: selectSingleChain({ data: { id: "dep-1", status: "active" } }) };
      }
      if (table === "deployment_revisions") {
        call++;
        // Target revision lookup (first call) -> not found.
        return { select: selectSingleChain({ data: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    });

    const result = await rollbackDeployment("proj-1", "dep-1", "rev-999", "bad build");

    expect(result).toEqual({ error: "Target revision not found for this deployment" });
    expect(call).toBe(1);
  });

  it("verifies the target revision is scoped to the deployment", async () => {
    const revisionSelect = selectSingleChain({ data: { id: "rev-1" } });
    const deploymentsSelect = selectSingleChain({ data: { id: "dep-1", status: "active" } });
    const deploymentsUpdate = updateChain({ error: null }, { data: [{ id: "dep-1" }], error: null });
    const revisionsUpdate = updateChain({ error: null });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "deployments") return { select: deploymentsSelect, update: deploymentsUpdate };
      if (table === "deployment_revisions") return { select: revisionSelect, update: revisionsUpdate };
      throw new Error(`unexpected table ${table}`);
    });

    await rollbackDeployment("proj-1", "dep-1", "rev-1", "bad build");

    const revisionChain = revisionSelect.mock.results[0].value;
    expect(revisionChain.eq).toHaveBeenCalledWith("id", "rev-1");
    expect(revisionChain.eq).toHaveBeenCalledWith("deployment_id", "dep-1");
  });

  it("reports not found/not permitted when the final update affects no rows", async () => {
    const revisionSelect = selectSingleChain({ data: { id: "rev-1" } });
    const deploymentsSelect = selectSingleChain({ data: { id: "dep-1", status: "active" } });
    const deploymentsUpdate = updateChain({ error: null }, { data: [], error: null });
    const revisionsUpdate = updateChain({ error: null });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "deployments") return { select: deploymentsSelect, update: deploymentsUpdate };
      if (table === "deployment_revisions") return { select: revisionSelect, update: revisionsUpdate };
      throw new Error(`unexpected table ${table}`);
    });

    const result = await rollbackDeployment("proj-1", "dep-1", "rev-1", "bad build");

    expect(result).toEqual({ error: "Deployment not found or not permitted" });
  });

  it("rolls back successfully, logs an audit event, and revalidates", async () => {
    const revisionSelect = selectSingleChain({ data: { id: "rev-1" } });
    const deploymentsSelect = selectSingleChain({ data: { id: "dep-1", status: "active" } });
    const deploymentsUpdate = updateChain({ error: null }, { data: [{ id: "dep-1" }], error: null });
    const revisionsUpdate = updateChain({ error: null });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "deployments") return { select: deploymentsSelect, update: deploymentsUpdate };
      if (table === "deployment_revisions") return { select: revisionSelect, update: revisionsUpdate };
      throw new Error(`unexpected table ${table}`);
    });

    const result = await rollbackDeployment("proj-1", "dep-1", "rev-1", "  bad build  ");

    expect(result).toEqual({ success: true });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        org_id: mockOrg.id,
        user_id: mockUser.id,
        action: "rollback",
        resource_type: "deployment",
        resource_id: "dep-1",
        details: { reason: "bad build", targetRevisionId: "rev-1" },
      }),
    );
  });
});
