import { describe, it, expect, vi, beforeEach } from "vitest";
import { DockerLocalDeployer } from "../docker-local-deployer";
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
  allocatePort: vi.fn().mockReturnValue({ proxyPort: 10003 }),
  releasePort: vi.fn(),
}));

vi.mock("../nginx-config", () => ({
  generateNginxConfig: vi.fn().mockReturnValue("mock-config"),
  writeNginxConfig: vi.fn(),
  reloadNginx: vi.fn(),
}));

// Fast-forward all sleeps
vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
  fn();
  return 0 as unknown as ReturnType<typeof setTimeout>;
});

const { isContainerRunning, inspectContainer, runContainer, removeContainerIfExists } =
  await import("../container-manager");
const { waitForHealthyViaDocker } = await import("../health-checker");
const { releasePort } = await import("../port-allocator");

function createCtx(overrides?: Partial<DeployContext>): DeployContext {
  return {
    client: {
      recordHealthCheck: vi.fn().mockResolvedValue(undefined),
      recordHealingEvent: vi.fn().mockResolvedValue(undefined),
    } as any,
    logStreamer: { push: vi.fn() } as any,
    job: { run_id: "run-1", project_slug: "myapp" } as any,
    deploymentId: "dep-1",
    revisionId: "rev-1",
    imageTag: "myapp:v2",
    config: { driver: "docker_local", strategy: "blue_green", port: 3000 } as any,
    projectSlug: "myapp",
    taskRunId: "task-1",
    secrets: {},
    ...overrides,
  };
}

function healthyResult() {
  return { passed: true, statusCode: null, responseTimeMs: 50, error: undefined };
}

describe("DockerLocalDeployer (blue-green)", () => {
  let deployer: DockerLocalDeployer;

  beforeEach(() => {
    vi.clearAllMocks();
    deployer = new DockerLocalDeployer();
  });

  describe("deploy", () => {
    it("starts the new color container and reports success", async () => {
      vi.mocked(isContainerRunning).mockResolvedValue(false);
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(true);
      expect(vi.mocked(runContainer)).toHaveBeenCalledWith(
        expect.objectContaining({ name: "deployx-myapp-blue", image: "myapp:v2" }),
      );
      const labels = (vi.mocked(runContainer).mock.calls[0][0] as any).labels;
      expect(labels["deployx.previousImage"]).toBeUndefined();
    });

    it("labels the new color with the image it replaces", async () => {
      vi.mocked(isContainerRunning).mockImplementation(
        async (name: string) => name === "deployx-myapp-blue",
      );
      vi.mocked(inspectContainer).mockImplementation(async (name: string) =>
        name === "deployx-myapp-blue"
          ? { id: "1", name, state: "running", image: "myapp:v1", labels: {} }
          : null,
      );
      vi.mocked(waitForHealthyViaDocker).mockResolvedValue(healthyResult());

      const result = await deployer.deploy(createCtx());

      expect(result.success).toBe(true);
      expect(vi.mocked(runContainer)).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "deployx-myapp-green",
          labels: expect.objectContaining({ "deployx.previousImage": "myapp:v1" }),
        }),
      );
    });
  });

  describe("stop", () => {
    it("removes both colors and the proxy, then releases the port", async () => {
      await deployer.stop(createCtx());

      expect(vi.mocked(removeContainerIfExists)).toHaveBeenCalledWith("deployx-myapp-blue");
      expect(vi.mocked(removeContainerIfExists)).toHaveBeenCalledWith("deployx-myapp-green");
      expect(vi.mocked(removeContainerIfExists)).toHaveBeenCalledWith("deployx-proxy-myapp");
      expect(vi.mocked(releasePort)).toHaveBeenCalledWith("myapp");

      const removeCalls = vi.mocked(removeContainerIfExists).mock;
      const proxyOrder =
        removeCalls.invocationCallOrder[
          removeCalls.calls.findIndex((c) => c[0] === "deployx-proxy-myapp")
        ];
      expect(vi.mocked(releasePort).mock.invocationCallOrder[0]).toBeGreaterThan(proxyOrder);
    });
  });
});
