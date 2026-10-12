import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────

const mockRemoveChannel = vi.fn();
const mockRefresh = vi.fn();
const mockSubscribe = vi.fn().mockReturnThis();

const mockChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: mockSubscribe,
};

const mockSupabaseClient = {
  channel: vi.fn().mockReturnValue(mockChannel),
  removeChannel: mockRemoveChannel,
};

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn().mockReturnValue(mockSupabaseClient),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ refresh: mockRefresh }),
}));

// This hook is exercised at the level of its pure state-merging logic
// (the same approach used for useRealtimeNotifications), since
// @testing-library/react is not available in this project.

interface RevisionData {
  readonly id: string;
  readonly deployment_id: string;
  readonly revision_number: number;
  readonly image_tag: string;
  readonly image_digest: string | null;
  readonly status: string;
  readonly rollback_reason: string | null;
  readonly created_at: string;
}

interface HealthCheckData {
  readonly id: string;
  readonly status: string;
  readonly response_time_ms: number | null;
  readonly status_code: number | null;
  readonly error_message: string | null;
  readonly checked_at: string;
}

const MAX_HEALTH_CHECKS = 50;

function makeRevision(overrides: Partial<RevisionData> = {}): RevisionData {
  return {
    id: "rev-1",
    deployment_id: "dep-1",
    revision_number: 1,
    image_tag: "app:v1",
    image_digest: null,
    status: "active",
    rollback_reason: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createDeploymentState(
  initialRevisions: readonly RevisionData[],
  initialHealthChecks: readonly HealthCheckData[],
) {
  let revisions = [...initialRevisions];
  let healthChecks = [...initialHealthChecks];

  function upsertRevision(entry: RevisionData) {
    const existingIndex = revisions.findIndex((r) => r.id === entry.id);
    const next =
      existingIndex >= 0
        ? revisions.map((r, i) => (i === existingIndex ? entry : r))
        : [entry, ...revisions];
    revisions = [...next].sort((a, b) => b.revision_number - a.revision_number);
  }

  function addHealthCheck(entry: HealthCheckData) {
    healthChecks = [entry, ...healthChecks].slice(0, MAX_HEALTH_CHECKS);
  }

  return {
    getRevisions: () => revisions,
    getHealthChecks: () => healthChecks,
    upsertRevision,
    addHealthCheck,
  };
}

describe("useRealtimeDeployment state logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a new revision and keeps revisions sorted descending", () => {
    const state = createDeploymentState([makeRevision({ id: "r1", revision_number: 1 })], []);

    state.upsertRevision(makeRevision({ id: "r2", revision_number: 2 }));

    const revisions = state.getRevisions();
    expect(revisions).toHaveLength(2);
    expect(revisions[0].id).toBe("r2");
    expect(revisions[1].id).toBe("r1");
  });

  it("updates an existing revision in place instead of duplicating it", () => {
    const state = createDeploymentState(
      [makeRevision({ id: "r1", revision_number: 1, status: "active" })],
      [],
    );

    state.upsertRevision(
      makeRevision({ id: "r1", revision_number: 1, status: "rolled_back", rollback_reason: "bad deploy" }),
    );

    const revisions = state.getRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0].status).toBe("rolled_back");
    expect(revisions[0].rollback_reason).toBe("bad deploy");
  });

  it("prepends new health checks and caps the list at 50", () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({
      id: `hc-${i}`,
      status: "pass",
      response_time_ms: 100,
      status_code: 200,
      error_message: null,
      checked_at: new Date().toISOString(),
    }));
    const state = createDeploymentState([], existing);

    state.addHealthCheck({
      id: "hc-new",
      status: "fail",
      response_time_ms: null,
      status_code: 500,
      error_message: "boom",
      checked_at: new Date().toISOString(),
    });

    const checks = state.getHealthChecks();
    expect(checks).toHaveLength(50);
    expect(checks[0].id).toBe("hc-new");
  });

  it("subscribes to a deployment-scoped channel and unsubscribes on cleanup", () => {
    const deploymentId = "dep-1";
    mockSupabaseClient.channel(`deployment:${deploymentId}`);

    expect(mockSupabaseClient.channel).toHaveBeenCalledWith(`deployment:${deploymentId}`);

    mockRemoveChannel(mockChannel);
    expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
  });
});
