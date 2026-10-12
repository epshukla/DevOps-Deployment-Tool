import { describe, it, expect, vi, beforeEach } from "vitest";

const { session } = vi.hoisted(() => ({
  session: {
    supabase: null as unknown,
    user: { id: "user-1" },
    org: { id: "org-a" },
    role: "developer",
  },
}));

vi.mock("@/lib/auth/session", () => ({
  requireUserWithOrg: vi.fn(async () => session),
}));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { submitApprovalVote } from "../actions";
import { createFakeSupabase, eqValue, type RecordedQuery } from "@/lib/__tests__/helpers/fake-supabase";

function approvalRow(projectId: string, orgId: string, status = "pending") {
  return {
    id: "appr-1",
    status,
    required_approvals: 1,
    task_runs: {
      pipeline_run_id: "run-1",
      pipeline_runs: { project_id: projectId, projects: { org_id: orgId } },
    },
  };
}

function setup(approval: unknown, approveCount = 1) {
  const fake = createFakeSupabase((q: RecordedQuery) => {
    if (q.table === "deployment_approvals" && q.operation === "select") return { data: approval };
    if (q.table === "approval_votes" && q.operation === "select") return { count: approveCount };
    return { data: null };
  });
  session.supabase = fake.client;
  return fake.queries;
}

describe("submitApprovalVote", () => {
  beforeEach(() => {
    session.role = "developer";
  });

  it("records the vote and approves once the threshold is met (conditionally)", async () => {
    const queries = setup(approvalRow("proj-1", "org-a"));

    const result = await submitApprovalVote("proj-1", "appr-1", "approve");

    expect(result).toEqual({ success: true });
    expect(queries.some((q) => q.table === "approval_votes" && q.operation === "insert")).toBe(true);
    const approve = queries.find((q) => q.table === "deployment_approvals" && q.operation === "update")!;
    expect(approve.payload).toMatchObject({ status: "approved" });
    expect(eqValue(approve, "status")).toBe("pending");
  });

  it("refuses approvals that belong to another org", async () => {
    const queries = setup(approvalRow("proj-1", "org-b"));

    const result = await submitApprovalVote("proj-1", "appr-1", "approve");

    expect(result).toEqual({ error: "Approval not found" });
    expect(queries.some((q) => q.operation === "insert")).toBe(false);
  });

  it("refuses approvals from a different project than the page's", async () => {
    setup(approvalRow("proj-other", "org-a"));
    const result = await submitApprovalVote("proj-1", "appr-1", "approve");
    expect(result).toEqual({ error: "Approval not found" });
  });

  it("refuses viewers", async () => {
    session.role = "viewer";
    setup(approvalRow("proj-1", "org-a"));
    const result = await submitApprovalVote("proj-1", "appr-1", "approve");
    expect(result.error).toMatch(/permission/);
  });

  it("does not vote on an already decided approval", async () => {
    setup(approvalRow("proj-1", "org-a", "rejected"));
    const result = await submitApprovalVote("proj-1", "appr-1", "approve");
    expect(result).toEqual({ error: "Approval is already rejected" });
  });
});
