import { describe, it, expect, vi, beforeEach } from "vitest";
import { DockerLocalRollingDeployer } from "../docker-local-rolling-deployer";
import type { DeployContext } from "../deployer-interface";

// Mock all dependencies
vi.mock("../container-manager", () => ({
  ensureNetwork: vi.fn(),
  runContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainerIfExists: vi.fn(),
  isContainerRunning: vi.fn(),
  inspectContainer: vi.fn(),
  getContainerLogs: vi.fn().mockResolvedValue(["log line 1"]),
}));

vi.mock("../health-checker", () => ({
  waitForHealthyViaDocker: vi.fn(),
  checkHealthViaDocker: vi.fn(),
}));

vi.mock("../port-allocator", () => ({
  allocatePort: vi.fn().mockReturnValue({ proxyPort: 10002 }),
  releasePort: vi.fn(),
}));

vi.mock("../nginx-config", () => ({
  generateWeightedNginxConfig: vi.fn().mockReturnValue("mock-config"),
  writeNginxConfig: vi.fn(),
  reloadNginx: vi.fn(),
}));

// Fast-forward all sleeps
vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
  fn();
  return 0 as unknown as ReturnType<typeof setTimeout>;
});

const { isContainerRunning, inspectContainer, runContainer, stopContainer, removeContainerIfExists } =
  await import("../container-manager");
const { waitForHealthyViaDocker, checkHealthViaDocker } = await import("../health-checker");
const { generateWeightedNginxConfig, reloadNginx } = await import("../nginx-config");

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
    imageTag: "myapp:v2",
    config: {
      driver: "docker_local",
      strategy: "rolling",
      port: 3000,
      rolling: { instances: 2, max_unavailable: 1, observation_seconds: 5 },
    } as any,
    projectSlug: "myapp",
    taskRunId: "task-1",
    secrets: {},
    ...overrides,
  };
}

function healthyResult() {
  return { passed: true, statusCode: 200, responseTimeMs: 50, error: undefined };
}

function unhealthyResult() {
  return { passed: false, statusCode: 500, responseTimeMs: 100, error: "Internal Server Error" };
}

describe("DockerLocalRollingDeployer", () => {
  let deployer: DockerLocalRollingDeployer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(inspectContainer).mockReset();
    deployer = new DockerLocalRollingDeployer();
  });

  describe("deploy — first deploy", () => {
    it("starts N instances when no existing instances found", async () => {
      vi.mocked(isContainerRunning).mockResolvedValue(false);
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(true);
      expect(vi.mocked(runContainer)).toHaveBeenCalledWith(
        expect.objectContaining({ name: "deployx-myapp-inst-0" }),
      );
      expect(vi.mocked(runContainer)).toHaveBeenCalledWith(
        expect.objectContaining({ name: "deployx-myapp-inst-1" }),
      );
    });

    it("configures nginx with all instances", async () => {
      vi.mocked(isContainerRunning).mockResolvedValue(false);
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx());

      expect(vi.mocked(generateWeightedNginxConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          upstreams: expect.arrayContaining([
            expect.objectContaining({ name: "deployx-myapp-inst-0" }),
            expect.objectContaining({ name: "deployx-myapp-inst-1" }),
          ]),
        }),
      );
    });

    it("cleans up on health check failure during first deploy", async () => {
      vi.mocked(isContainerRunning).mockResolvedValue(false);
      vi.mocked(waitForHealthyViaDocker)
        .mockResolvedValueOnce(healthyResult())
        .mockResolvedValueOnce(unhealthyResult());

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain("health check failed");
    });

    it("sets correct labels including strategy and ordinal", async () => {
      vi.mocked(isContainerRunning).mockResolvedValue(false);
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx());

      expect(vi.mocked(runContainer)).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            "deployx.strategy": "rolling",
            "deployx.ordinal": "0",
            "deployx.role": "app",
          }),
        }),
      );
    });
  });

  describe("deploy — rolling update", () => {
    beforeEach(() => {
      // Existing instances are running
      vi.mocked(isContainerRunning).mockImplementation(async (name: string) => {
        if (name === "deployx-myapp-inst-0") return true;
        if (name === "deployx-myapp-inst-1") return true;
        return false; // proxy
      });
      vi.mocked(inspectContainer).mockImplementation(async (name: string) => {
        if (name === "deployx-myapp-inst-0" || name === "deployx-myapp-inst-1") {
          return { id: name, name, state: "running", image: "myapp:v1", labels: {} };
        }
        return null;
      });
    });

    it("rolls failed instances back to the real previous image", async () => {
      vi.mocked(waitForHealthyViaDocker)
        .mockResolvedValueOnce(healthyResult())
        .mockResolvedValueOnce(unhealthyResult());

      await deployer.deploy(createCtx());

      const rollbackRuns = vi.mocked(runContainer).mock.calls.filter(
        (c) => (c[0] as any).image === "myapp:v1",
      );
      expect(rollbackRuns.map((c) => (c[0] as any).name)).toEqual([
        "deployx-myapp-inst-0",
        "deployx-myapp-inst-1",
      ]);
    });

    it("labels new instances with the image they replace", async () => {
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx());

      const newRuns = vi.mocked(runContainer).mock.calls.filter(
        (c) => (c[0] as any).image === "myapp:v2",
      );
      expect(newRuns).toHaveLength(2);
      for (const call of newRuns) {
        expect((call[0] as any).labels["deployx.previousImage"]).toBe("myapp:v1");
      }
    });

    it("reloads nginx after each batch passes health, before the next batch starts", async () => {
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx());

      const firstHealthy = vi.mocked(waitForHealthyViaDocker).mock.invocationCallOrder[0];
      const secondBatchStop = vi.mocked(stopContainer).mock.invocationCallOrder[
        vi.mocked(stopContainer).mock.calls.findIndex((c) => c[0] === "deployx-myapp-inst-1")
      ];
      const reloads = vi.mocked(reloadNginx).mock.invocationCallOrder;
      expect(reloads.some((o) => o > firstHealthy && o < secondBatchStop)).toBe(true);
    });

    it("drains a batch from nginx before stopping its old instances", async () => {
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx());

      const firstConfig = vi.mocked(generateWeightedNginxConfig).mock.calls[0][0] as any;
      expect(firstConfig.upstreams.map((u: any) => u.name)).toEqual(["deployx-myapp-inst-1"]);
      const firstStop = vi.mocked(stopContainer).mock.invocationCallOrder[0];
      expect(vi.mocked(reloadNginx).mock.invocationCallOrder[0]).toBeLessThan(firstStop);
    });

    it("only routes to instances that exist (scale-up)", async () => {
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());
      const running = new Set(["deployx-myapp-inst-0", "deployx-myapp-inst-1"]);
      vi.mocked(isContainerRunning).mockImplementation(async (name: string) => running.has(name));
      vi.mocked(runContainer).mockImplementation(async (opts: any) => {
        running.add(opts.name);
        return "id";
      });

      await deployer.deploy(
        createCtx({
          config: {
            driver: "docker_local",
            strategy: "rolling",
            port: 3000,
            rolling: { instances: 3, max_unavailable: 1, observation_seconds: 1 },
          } as any,
        }),
      );

      // After batch 0 (inst-0 replaced), inst-2 doesn't exist yet
      const afterFirstBatch = vi.mocked(generateWeightedNginxConfig).mock.calls[1][0] as any;
      expect(afterFirstBatch.upstreams.map((u: any) => u.name)).toEqual([
        "deployx-myapp-inst-0",
        "deployx-myapp-inst-1",
      ]);
      vi.mocked(runContainer).mockReset();
    });

    it("replaces instances one at a time", async () => {
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      const ctx = createCtx();
      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(true);

      // Should stop each old instance before starting new
      expect(vi.mocked(stopContainer)).toHaveBeenCalledWith(
        "deployx-myapp-inst-0",
        10,
      );
      expect(vi.mocked(stopContainer)).toHaveBeenCalledWith(
        "deployx-myapp-inst-1",
        10,
      );
    });

    it("records rolling_instance_updated events", async () => {
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      const ctx = createCtx();
      await deployer.deploy(ctx);

      const client = ctx.client as any;
      const updateCalls = client.recordHealingEvent.mock.calls.filter(
        (c: any[]) => c[2]?.event_type === "rolling_instance_updated",
      );

      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[0][2].details.ordinal).toBe(0);
      expect(updateCalls[1][2].details.ordinal).toBe(1);
    });

    it("rolls back updated instances on health check failure", async () => {
      // First instance healthy, second unhealthy
      vi.mocked(waitForHealthyViaDocker)
        .mockResolvedValueOnce(healthyResult())
        .mockResolvedValueOnce(unhealthyResult());

      const ctx = createCtx();
      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Instance 1 unhealthy");
    });

    it("records rolling_rollback event on failure", async () => {
      vi.mocked(waitForHealthyViaDocker)
        .mockResolvedValueOnce(healthyResult())
        .mockResolvedValueOnce(unhealthyResult());

      const ctx = createCtx();
      await deployer.deploy(ctx);

      const client = ctx.client as any;
      const rollbackCalls = client.recordHealingEvent.mock.calls.filter(
        (c: any[]) => c[2]?.event_type === "rolling_rollback",
      );
      expect(rollbackCalls).toHaveLength(1);
      expect(rollbackCalls[0][2].details.failed_ordinal).toBe(1);
    });

    it("updates nginx after each batch", async () => {
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      await deployer.deploy(createCtx());

      // nginx should be updated at least twice (once per batch with maxUnavailable=1)
      expect(vi.mocked(generateWeightedNginxConfig).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("uses custom instance count from config", async () => {
      vi.mocked(isContainerRunning).mockImplementation(async (name: string) => {
        return name.includes("inst-");
      });
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      const ctx = createCtx({
        config: {
          driver: "docker_local",
          strategy: "rolling",
          port: 3000,
          rolling: { instances: 3, max_unavailable: 1, observation_seconds: 1 },
        } as any,
      });

      await deployer.deploy(ctx);

      const client = ctx.client as any;
      const updateCalls = client.recordHealingEvent.mock.calls.filter(
        (c: any[]) => c[2]?.event_type === "rolling_instance_updated",
      );
      expect(updateCalls).toHaveLength(3);
    });
  });

  describe("rollback", () => {
    it("deploys target image to all instances", async () => {
      vi.mocked(isContainerRunning).mockResolvedValue(false);
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      const result = await deployer.rollback(createCtx(), "myapp:v1");

      expect(result.success).toBe(true);
      // Should use the rollback image
      const runCalls = vi.mocked(runContainer).mock.calls.filter(
        (c) => (c[0] as any).image === "myapp:v1",
      );
      expect(runCalls.length).toBeGreaterThan(0);
    });
  });

  describe("stop", () => {
    it("removes all instances and proxy", async () => {
      await deployer.stop(createCtx());

      expect(vi.mocked(removeContainerIfExists)).toHaveBeenCalledWith("deployx-myapp-inst-0");
      expect(vi.mocked(removeContainerIfExists)).toHaveBeenCalledWith("deployx-myapp-inst-1");
      expect(vi.mocked(removeContainerIfExists)).toHaveBeenCalledWith("deployx-proxy-myapp");
    });

    it("releases the proxy port after the proxy is removed", async () => {
      const { releasePort } = await import("../port-allocator");

      await deployer.stop(createCtx());

      expect(vi.mocked(releasePort)).toHaveBeenCalledWith("myapp");
      const proxyRemovalOrder = vi.mocked(removeContainerIfExists).mock.invocationCallOrder[
        vi.mocked(removeContainerIfExists).mock.calls.findIndex((c) => c[0] === "deployx-proxy-myapp")
      ];
      expect(vi.mocked(releasePort).mock.invocationCallOrder[0]).toBeGreaterThan(proxyRemovalOrder);
    });

    it("keeps the port allocated if proxy removal fails", async () => {
      const { releasePort } = await import("../port-allocator");
      vi.mocked(removeContainerIfExists).mockImplementation(async (name: string) => {
        if (name === "deployx-proxy-myapp") throw new Error("daemon unavailable");
      });

      await expect(deployer.stop(createCtx())).rejects.toThrow("daemon unavailable");
      expect(vi.mocked(releasePort)).not.toHaveBeenCalled();
      vi.mocked(removeContainerIfExists).mockReset();
    });
  });

  describe("getStatus", () => {
    it("returns active when any instance is running", async () => {
      vi.mocked(isContainerRunning).mockImplementation(async (name: string) => {
        return name === "deployx-myapp-inst-0";
      });

      const status = await deployer.getStatus("myapp");
      expect(status).toBe("active");
    });

    it("returns stopped when no instances are running", async () => {
      vi.mocked(isContainerRunning).mockResolvedValue(false);
      const status = await deployer.getStatus("myapp");
      expect(status).toBe("stopped");
    });
  });

  describe("getHealth", () => {
    it("returns healthy when all instances pass health check", async () => {
      vi.mocked(isContainerRunning).mockImplementation(async (name: string) => {
        return name === "deployx-myapp-inst-0" || name === "deployx-myapp-inst-1";
      });
      vi.mocked(checkHealthViaDocker).mockResolvedValue(healthyResult());

      const health = await deployer.getHealth("myapp", "/health", 3000);
      expect(health).toBe("healthy");
    });

    it("returns unknown when no instances running", async () => {
      vi.mocked(isContainerRunning).mockResolvedValue(false);

      const health = await deployer.getHealth("myapp", "/health", 3000);
      expect(health).toBe("unknown");
    });
  });

  describe("getLogs", () => {
    it("delegates to container-manager", async () => {
      const logs = await deployer.getLogs("deployx-myapp-inst-0", 50);
      expect(logs).toEqual(["log line 1"]);
    });
  });
});
