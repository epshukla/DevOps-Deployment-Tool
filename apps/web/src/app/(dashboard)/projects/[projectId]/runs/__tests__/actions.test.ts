import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────

const { mockSupabase, mockUser, mockOrg, mockRole } = vi.hoisted(() => ({
  mockSupabase: { from: vi.fn() },
  mockUser: { id: "user-1" },
  mockOrg: { id: "org-1" },
  mockRole: "developer",
}));

vi.mock("@/lib/auth/session", () => ({
  requireUserWithOrg: vi.fn().mockResolvedValue({
    supabase: mockSupabase,
    user: mockUser,
    org: mockOrg,
    role: mockRole,
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { rerunPipelineRun } from "../actions";

// ── Helpers ────────────────────────────────────────────────────

interface MockOptions {
  readonly sourceRun?: {
    id: string;
    status: string;
    pipeline_definition_id: string;
    pipeline_version_id: string;
    git_branch: string | null;
    git_sha: string | null;
  } | null;
  readonly insertError?: boolean;
  readonly queueError?: boolean;
}

function buildMocks(options: MockOptions = {}) {
  const {
    sourceRun = {
      id: "run-1",
      status: "success",
      pipeline_definition_id: "def-1",
      pipeline_version_id: "ver-1",
      git_branch: "main",
      git_sha: "abc1234",
    },
    insertError = false,
    queueError = false,
  } = options;

  const sourceSingle = vi.fn().mockResolvedValue({ data: sourceRun, error: null });
  const sourceEq2 = vi.fn().mockReturnValue({ single: sourceSingle });
  const sourceEq1 = vi.fn().mockReturnValue({ eq: sourceEq2 });
  const sourceSelect = vi.fn().mockReturnValue({ eq: sourceEq1 });

  const insertSingle = vi.fn().mockResolvedValue({
    data: insertError ? null : { id: "run-2" },
    error: insertError ? new Error("insert failed") : null,
  });
  const insertSelect = vi.fn().mockReturnValue({ single: insertSingle });
  const insert = vi.fn().mockReturnValue({ select: insertSelect });

  const updateEq = vi.fn().mockResolvedValue({
    error: queueError ? new Error("queue failed") : null,
  });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  mockSupabase.from.mockReturnValue({
    select: sourceSelect,
    insert,
    update,
  });

  return { insert, update, updateEq };
}

// ── Tests ──────────────────────────────────────────────────────

describe("rerunPipelineRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new queued run reusing the definition/version/branch/sha", async () => {
    const { insert, update, updateEq } = buildMocks();

    const result = await rerunPipelineRun("project-1", "run-1");

    expect(result).toEqual({ run_id: "run-2" });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline_definition_id: "def-1",
        pipeline_version_id: "ver-1",
        project_id: "project-1",
        status: "created",
        trigger_type: "manual",
        git_branch: "main",
        git_sha: "abc1234",
        created_by: mockUser.id,
      }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "queued" }));
    expect(updateEq).toHaveBeenCalledWith("id", "run-2");
  });

  it("returns an error when the run is not found", async () => {
    buildMocks({ sourceRun: null });

    const result = await rerunPipelineRun("project-1", "missing-run");

    expect(result).toEqual({ error: "Run not found" });
  });

  it("returns an error when the source run is not yet terminal", async () => {
    buildMocks({
      sourceRun: {
        id: "run-1",
        status: "running",
        pipeline_definition_id: "def-1",
        pipeline_version_id: "ver-1",
        git_branch: "main",
        git_sha: "abc1234",
      },
    });

    const result = await rerunPipelineRun("project-1", "run-1");

    expect(result).toEqual({ error: "Run must be finished before it can be re-run" });
  });

  it("returns an error when creating the new run fails", async () => {
    buildMocks({ insertError: true });

    const result = await rerunPipelineRun("project-1", "run-1");

    expect(result).toEqual({ error: "Failed to create re-run" });
  });

  it("returns an error when queueing the new run fails", async () => {
    buildMocks({ queueError: true });

    const result = await rerunPipelineRun("project-1", "run-1");

    expect(result).toEqual({ error: "Failed to queue re-run" });
  });
});
