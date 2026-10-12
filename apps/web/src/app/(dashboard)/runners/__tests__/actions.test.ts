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

vi.mock("@/lib/auth/runner", () => ({
  generateToken: vi.fn().mockReturnValue({ token: "plaintext-token", hash: "hashed-token" }),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { generateRunnerToken, revokeRunner } from "../actions";
import { recordAuditEvent } from "@/lib/audit";

function makeFormData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

interface SelectChain {
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
}

function selectSingleChain(result: { data: unknown; error?: unknown }) {
  const chain = {} as SelectChain;
  chain.single = vi.fn().mockResolvedValue(result);
  chain.eq = vi.fn().mockReturnValue(chain);
  return vi.fn().mockReturnValue(chain);
}

function withRole(role: string) {
  mockRequireUserWithOrg.mockResolvedValue({
    supabase: mockSupabase,
    user: mockUser,
    org: mockOrg,
    role,
  });
}

describe("generateRunnerToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withRole("admin");
  });

  it("rejects callers below admin role", async () => {
    withRole("developer");

    const result = await generateRunnerToken({}, makeFormData({ name: "runner-1" }));

    expect(result).toEqual({ error: "You need admin permissions to register runners" });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("requires a non-empty name", async () => {
    const result = await generateRunnerToken({}, makeFormData({ name: "  " }));

    expect(result).toEqual({ error: "Runner name is required" });
  });

  it("creates the runner registration, logs an audit event, and returns the token", async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: "runner-1" }, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    mockSupabase.from.mockReturnValue({ insert });

    const result = await generateRunnerToken({}, makeFormData({ name: "build-box" }));

    expect(result).toEqual({ token: "plaintext-token", runner_id: "runner-1" });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: mockOrg.id,
        name: "build-box",
        token_hash: "hashed-token",
        status: "offline",
      }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        org_id: mockOrg.id,
        user_id: mockUser.id,
        action: "create",
        resource_type: "runner_registration",
        resource_id: "runner-1",
        details: { name: "build-box" },
      }),
    );
  });
});

describe("revokeRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withRole("admin");
  });

  it("rejects callers below admin role", async () => {
    withRole("developer");

    const result = await revokeRunner("runner-1");

    expect(result).toEqual({ error: "You need admin permissions to revoke runners" });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("returns an error when the runner is not found", async () => {
    mockSupabase.from.mockReturnValue({ select: selectSingleChain({ data: null }) });

    const result = await revokeRunner("runner-1");

    expect(result).toEqual({ error: "Runner not found" });
  });

  it("refuses to revoke a busy runner without force", async () => {
    mockSupabase.from.mockReturnValue({
      select: selectSingleChain({
        data: { id: "runner-1", name: "build-box", current_job_id: "job-1" },
      }),
    });

    const result = await revokeRunner("runner-1");

    expect(result).toEqual({
      error: "This runner is currently busy with a job. Force revoke to proceed anyway.",
      busy: true,
    });
  });

  it("revokes a busy runner when forced", async () => {
    const select = selectSingleChain({
      data: { id: "runner-1", name: "build-box", current_job_id: "job-1" },
    });
    const finalSelect = vi.fn().mockResolvedValue({ data: [{ id: "runner-1" }], error: null });
    const eqSecond = vi.fn().mockReturnValue({ select: finalSelect });
    const eqFirst = vi.fn().mockReturnValue({ eq: eqSecond });
    const deleteFn = vi.fn().mockReturnValue({ eq: eqFirst });

    mockSupabase.from.mockReturnValue({ select, delete: deleteFn });

    const result = await revokeRunner("runner-1", true);

    expect(result).toEqual({ success: true });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        action: "delete",
        resource_type: "runner_registration",
        resource_id: "runner-1",
        details: { name: "build-box", forced: true },
      }),
    );
  });

  it("reports not found/not permitted when the delete affects no rows", async () => {
    const select = selectSingleChain({
      data: { id: "runner-1", name: "build-box", current_job_id: null },
    });
    const finalSelect = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqSecond = vi.fn().mockReturnValue({ select: finalSelect });
    const eqFirst = vi.fn().mockReturnValue({ eq: eqSecond });
    const deleteFn = vi.fn().mockReturnValue({ eq: eqFirst });

    mockSupabase.from.mockReturnValue({ select, delete: deleteFn });

    const result = await revokeRunner("runner-1");

    expect(result).toEqual({ error: "Runner not found or not permitted" });
  });

  it("revokes an idle runner and logs a non-forced audit event", async () => {
    const select = selectSingleChain({
      data: { id: "runner-1", name: "build-box", current_job_id: null },
    });
    const finalSelect = vi.fn().mockResolvedValue({ data: [{ id: "runner-1" }], error: null });
    const eqSecond = vi.fn().mockReturnValue({ select: finalSelect });
    const eqFirst = vi.fn().mockReturnValue({ eq: eqSecond });
    const deleteFn = vi.fn().mockReturnValue({ eq: eqFirst });

    mockSupabase.from.mockReturnValue({ select, delete: deleteFn });

    const result = await revokeRunner("runner-1");

    expect(result).toEqual({ success: true });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({ details: { name: "build-box", forced: false } }),
    );
  });
});
