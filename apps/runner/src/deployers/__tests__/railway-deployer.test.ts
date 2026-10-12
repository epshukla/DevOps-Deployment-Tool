import { describe, it, expect, vi, beforeEach } from "vitest";
import { RailwayDeployer } from "../railway-deployer";
import type { DeployContext } from "../deployer-interface";

// Mock all dependencies
vi.mock("../clients", () => ({
  RailwayApiClient: vi.fn(),
}));

vi.mock("../health-checker", () => ({
  waitForHealthy: vi.fn(),
  checkHealth: vi.fn(),
}));

// Fast-forward all sleeps
vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
  fn();
  return 0 as unknown as ReturnType<typeof setTimeout>;
});

const { RailwayApiClient: MockRailwayApiClient } = await import("../clients");
const { waitForHealthy } = await import("../health-checker");

// ── Helpers ───────────────────────────────────────────────────────

function createMockClient() {
  return {
    recordHealthCheck: vi.fn().mockResolvedValue(undefined),
    recordHealingEvent: vi.fn().mockResolvedValue(undefined),
    updateDeployment: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("../../api-client").RunnerApiClient;
}

function createCtx(overrides?: Partial<DeployContext>): DeployContext {
  return {
    client: createMockClient(),
    logStreamer: { push: vi.fn() } as any,
    job: { run_id: "run-1", project_slug: "myapp" } as any,
    deploymentId: "dep-1",
    revisionId: "rev-1",
    imageTag: "ghcr.io/org/myapp:v2",
    config: {
      driver: "railway",
      strategy: "blue_green",
      port: 3000,
    } as any,
    projectSlug: "myapp",
    taskRunId: "task-1",
    secrets: {
      RAILWAY_API_TOKEN: "test-token",
      RAILWAY_PROJECT_ID: "proj-123",
    },
    ...overrides,
  };
}

function createMockRailwayClient() {
  return {
    getProject: vi.fn().mockResolvedValue({
      id: "proj-123",
      name: "proj",
      services: [],
      environments: [
        { id: "env-staging", name: "staging" },
        { id: "env-prod", name: "production" },
      ],
    }),
    createService: vi.fn().mockResolvedValue({
      id: "svc-1",
      projectId: "proj-123",
      name: "deployx-myapp",
    }),
    connectServiceImage: vi.fn().mockResolvedValue(undefined),
    upsertVariables: vi.fn().mockResolvedValue(undefined),
    updateServiceInstance: vi.fn().mockResolvedValue(undefined),
    deployServiceInstance: vi.fn().mockResolvedValue("deploy-1"),
    getDeployment: vi.fn().mockResolvedValue({
      id: "deploy-1",
      status: "SUCCESS",
      staticUrl: "myapp.up.railway.app",
    }),
    cancelDeployment: vi.fn().mockResolvedValue(undefined),
    stopDeployment: vi.fn().mockResolvedValue(undefined),
    getDeploymentLogs: vi.fn().mockResolvedValue([]),
  };
}

function withExistingService(mock: ReturnType<typeof createMockRailwayClient>) {
  mock.getProject.mockResolvedValue({
    id: "proj-123",
    name: "proj",
    services: [{ id: "svc-1", name: "deployx-myapp", projectId: "proj-123" }],
    environments: [{ id: "env-prod", name: "production" }],
  });
}

function healthyResult() {
  return { passed: true, statusCode: 200, responseTimeMs: 50, error: undefined };
}

function unhealthyResult() {
  return { passed: false, statusCode: 500, responseTimeMs: 100, error: "Service unavailable" };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("RailwayDeployer", () => {
  let deployer: RailwayDeployer;
  let mockRailway: ReturnType<typeof createMockRailwayClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    deployer = new RailwayDeployer();
    mockRailway = createMockRailwayClient();
    vi.mocked(MockRailwayApiClient).mockImplementation(() => mockRailway as any);
  });

  describe("deploy", () => {
    it("successful first deploy — creates image service, deploys to production env, health passes", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(true);
      expect(result.publicUrl).toBe("https://myapp.up.railway.app");
      expect(mockRailway.createService).toHaveBeenCalledWith(
        "proj-123",
        "deployx-myapp",
        "ghcr.io/org/myapp:v2",
      );
      expect(mockRailway.connectServiceImage).not.toHaveBeenCalled();
      expect(mockRailway.deployServiceInstance).toHaveBeenCalledWith("svc-1", "env-prod");
    });

    it("uses an account token with Bearer auth by default", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx());

      expect(MockRailwayApiClient).toHaveBeenCalledWith({
        apiToken: "test-token",
        tokenType: "account",
      });
    });

    it("falls back to a project token when only RAILWAY_PROJECT_TOKEN is set", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      const result = await deployer.deploy(createCtx({
        secrets: { RAILWAY_PROJECT_TOKEN: "proj-token", RAILWAY_PROJECT_ID: "proj-123" },
      }));

      expect(result.success).toBe(true);
      expect(MockRailwayApiClient).toHaveBeenCalledWith({
        apiToken: "proj-token",
        tokenType: "project",
      });
    });

    it("finds existing service, points it at the new image, and skips creation", async () => {
      withExistingService(mockRailway);
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(true);
      expect(mockRailway.createService).not.toHaveBeenCalled();
      expect(mockRailway.connectServiceImage).toHaveBeenCalledWith("svc-1", "ghcr.io/org/myapp:v2");
    });

    it("uses RAILWAY_ENVIRONMENT_ID secret when provided", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx({
        secrets: {
          RAILWAY_API_TOKEN: "test-token",
          RAILWAY_PROJECT_ID: "proj-123",
          RAILWAY_ENVIRONMENT_ID: "env-custom",
        },
      }));

      expect(mockRailway.deployServiceInstance).toHaveBeenCalledWith("svc-1", "env-custom");
    });

    it("fails when the environment cannot be determined", async () => {
      mockRailway.getProject.mockResolvedValue({
        id: "proj-123",
        name: "proj",
        services: [],
        environments: [{ id: "a", name: "dev" }, { id: "b", name: "qa" }],
      });

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain("RAILWAY_ENVIRONMENT_ID");
      expect(mockRailway.deployServiceInstance).not.toHaveBeenCalled();
    });

    it("passes deploy env as service variables", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());
      const ctx = createCtx({
        config: { driver: "railway", strategy: "blue_green", port: 3000, env: { NODE_ENV: "production" } } as any,
      });

      await deployer.deploy(ctx);

      expect(mockRailway.upsertVariables).toHaveBeenCalledWith(
        { projectId: "proj-123", environmentId: "env-prod", serviceId: "svc-1" },
        { NODE_ENV: "production" },
      );
    });

    it("passes railway.region through serviceInstanceUpdate before deploying", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());
      const ctx = createCtx({
        config: { driver: "railway", strategy: "blue_green", port: 3000, railway: { region: "us-west1" } } as any,
      });

      await deployer.deploy(ctx);

      expect(mockRailway.updateServiceInstance).toHaveBeenCalledWith(
        "svc-1",
        "env-prod",
        { region: "us-west1" },
      );
      const updateOrder = mockRailway.updateServiceInstance.mock.invocationCallOrder[0];
      const deployOrder = mockRailway.deployServiceInstance.mock.invocationCallOrder[0];
      expect(updateOrder).toBeLessThan(deployOrder);
    });

    it("does not touch region or variables when not configured", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx());

      expect(mockRailway.updateServiceInstance).not.toHaveBeenCalled();
      expect(mockRailway.upsertVariables).not.toHaveBeenCalled();
    });

    it("returns error when no Railway token is set", async () => {
      const ctx = createCtx({ secrets: { RAILWAY_PROJECT_ID: "proj-123" } });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("RAILWAY_API_TOKEN");
    });

    it("returns error when RAILWAY_PROJECT_ID is missing", async () => {
      const ctx = createCtx({ secrets: { RAILWAY_API_TOKEN: "test-token" } });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("RAILWAY_PROJECT_ID");
    });

    it("returns failure when deployment status becomes FAILED", async () => {
      mockRailway.getDeployment.mockResolvedValue({ id: "deploy-1", status: "FAILED" });
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain("FAILED");
    });

    it("treats CRASHED as a terminal failure", async () => {
      mockRailway.getDeployment
        .mockResolvedValueOnce({ id: "deploy-1", status: "DEPLOYING" })
        .mockResolvedValueOnce({ id: "deploy-1", status: "CRASHED" });

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain("CRASHED");
      expect(mockRailway.getDeployment).toHaveBeenCalledTimes(2);
    });

    it("surfaces API errors as a failed result", async () => {
      mockRailway.deployServiceInstance.mockRejectedValue(
        new Error("Railway API serviceInstanceDeployV2 returned errors: Not Authorized"),
      );

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Not Authorized");
    });

    it("returns failure when health check fails", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(unhealthyResult());

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Health check failed");
    });

    it("returns error for non-registry-qualified image tag", async () => {
      const ctx = createCtx({ imageTag: "myapp:v2" });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("registry-qualified");
    });

    it("pushes log messages via logStreamer", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      const ctx = createCtx();
      await deployer.deploy(ctx);

      const messages = vi.mocked(ctx.logStreamer.push).mock.calls.map(
        (c) => (c[0] as any).message,
      );
      expect(messages.some((m: string) => m.includes("[railway] Starting deployment"))).toBe(true);
      expect(messages.some((m: string) => m.includes("[railway] Using service"))).toBe(true);
      expect(messages.some((m: string) => m.includes("[railway] Deployment created"))).toBe(true);
      expect(messages.some((m: string) => m.includes("[railway] Deployment live"))).toBe(true);
    });

    it("reports health check result via client.recordHealthCheck", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      const ctx = createCtx();
      await deployer.deploy(ctx);

      expect(vi.mocked(ctx.client.recordHealthCheck)).toHaveBeenCalledWith(
        "run-1",
        "dep-1",
        expect.objectContaining({ status: "pass" }),
      );
    });
  });

  describe("rollback", () => {
    it("deploys with the target image tag", async () => {
      withExistingService(mockRailway);
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());

      const result = await deployer.rollback(createCtx(), "ghcr.io/org/myapp:v1");

      expect(result.success).toBe(true);
      expect(mockRailway.connectServiceImage).toHaveBeenCalledWith("svc-1", "ghcr.io/org/myapp:v1");
      expect(mockRailway.deployServiceInstance).toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("stops the cached deployment when it is live", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());
      const ctx = createCtx();
      await deployer.deploy(ctx);

      await deployer.stop(ctx);

      expect(mockRailway.stopDeployment).toHaveBeenCalledWith("deploy-1");
      expect(mockRailway.cancelDeployment).not.toHaveBeenCalled();
    });

    it("cancels the cached deployment when it is still building", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());
      const ctx = createCtx();
      await deployer.deploy(ctx);
      mockRailway.getDeployment.mockResolvedValue({ id: "deploy-1", status: "BUILDING" });

      await deployer.stop(ctx);

      expect(mockRailway.cancelDeployment).toHaveBeenCalledWith("deploy-1");
      expect(mockRailway.stopDeployment).not.toHaveBeenCalled();
    });

    it("logs a warning when stopping fails", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());
      const ctx = createCtx();
      await deployer.deploy(ctx);
      mockRailway.stopDeployment.mockRejectedValue(new Error("boom"));

      await deployer.stop(ctx);

      expect(ctx.logStreamer.push).toHaveBeenCalledWith(
        expect.objectContaining({ level: "warn", message: expect.stringContaining("boom") }),
      );
    });

    it("does nothing without a cached deployment", async () => {
      await deployer.stop(createCtx());

      expect(mockRailway.stopDeployment).not.toHaveBeenCalled();
      expect(mockRailway.cancelDeployment).not.toHaveBeenCalled();
    });
  });

  describe("getLogs", () => {
    it("returns empty array when no cached client exists", async () => {
      const logs = await deployer.getLogs("any-container");
      expect(logs).toEqual([]);
    });

    it("formats deployment logs after a deploy", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());
      await deployer.deploy(createCtx());
      mockRailway.getDeploymentLogs.mockResolvedValue([
        { timestamp: "2025-01-01T00:00:00Z", message: "Ready" },
      ]);

      const logs = await deployer.getLogs("any", 10);

      expect(logs).toEqual(["2025-01-01T00:00:00Z Ready"]);
      expect(mockRailway.getDeploymentLogs).toHaveBeenCalledWith("deploy-1", 10);
    });

    it("logs and returns empty array when fetching logs fails", async () => {
      vi.mocked(waitForHealthy).mockResolvedValue(healthyResult());
      await deployer.deploy(createCtx());
      mockRailway.getDeploymentLogs.mockRejectedValue(new Error("rate limited"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const logs = await deployer.getLogs("any");

      expect(logs).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
      warn.mockRestore();
    });
  });
});
