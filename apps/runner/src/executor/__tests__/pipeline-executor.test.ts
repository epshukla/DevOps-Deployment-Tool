import { describe, it, expect, vi, beforeEach } from "vitest";
import { executePipeline } from "../pipeline-executor";
import type { ClaimedJob, JobPayload, RunnerApiClient } from "../../api-client";
import type { StepExecutorOptions, StepResult } from "../step-executor";

vi.mock("../workspace", () => ({
  createWorkspace: vi.fn().mockResolvedValue({ path: "/tmp/deployx-ws", cleanup: vi.fn().mockResolvedValue(undefined) }),
  getHeadSha: vi.fn().mockResolvedValue("abcdef1234567890abcdef1234567890abcdef12"),
}));

vi.mock("../step-executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../step-executor")>()),
  executeStep: vi.fn(),
}));

vi.mock("../artifact-uploader", () => ({
  uploadTaskArtifacts: vi.fn().mockResolvedValue({ uploaded: 1, failed: 0, skipped: 0 }),
}));

vi.mock("../../docker/docker-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../docker/docker-client")>()),
  checkDocker: vi.fn().mockResolvedValue(true),
  buildImage: vi.fn(),
  pushImage: vi.fn(),
}));

const deployMock = vi.fn();
vi.mock("../../deployers", () => ({
  createDeployer: vi.fn(() => ({ deploy: deployMock })),
}));

const { executeStep } = await import("../step-executor");
const { uploadTaskArtifacts } = await import("../artifact-uploader");
const { buildImage, pushImage } = await import("../../docker/docker-client");

// ── Fixtures ────────────────────────────────────────────────────

type Tasks = Record<string, Record<string, unknown>>;

type MockClient = Record<string, ReturnType<typeof vi.fn>>;

function createClient(overrides: MockClient = {}): MockClient {
  return {
    reportStatus: vi.fn().mockResolvedValue(undefined),
    sendLogs: vi.fn().mockResolvedValue(undefined),
    getSecrets: vi.fn().mockResolvedValue({}),
    getRunStatus: vi.fn().mockResolvedValue({ status: "running" }),
    getApprovalStatus: vi.fn().mockResolvedValue({ status: "approved" }),
    createDeployment: vi.fn().mockResolvedValue({ deployment_id: "dep-1", revision_id: "rev-1" }),
    updateDeployment: vi.fn().mockResolvedValue(undefined),
    recordImage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const job = {
  run_id: "run-1",
  project_id: "proj-1",
  project_name: "My App",
  project_slug: "myapp",
  git_repo_url: "https://github.com/acme/myapp.git",
  git_branch: "main",
  git_sha: null,
  git_clone_token: null,
  dockerfile_path: "Dockerfile",
  build_context: ".",
  deploy_target: "docker_local",
  config_json: null,
} as JobPayload;

function claimed(tasks: Tasks): ClaimedJob {
  return {
    id: "run-1",
    project_id: "proj-1",
    git_branch: "main",
    git_sha: null,
    config_json: { tasks },
    task_runs: Object.keys(tasks).map((name) => ({
      id: `tr-${name}`,
      task_name: name,
      step_runs: [],
    })),
  };
}

function run(client: MockClient, tasks: Tasks) {
  return executePipeline({
    client: client as unknown as RunnerApiClient,
    job,
    claimed: claimed(tasks),
    pollIntervals: { cancelMs: 5, approvalMs: 5 },
  });
}

function statuses(client: MockClient): string[] {
  return client.reportStatus.mock.calls.map(([, p]) =>
    p.scope === "pipeline"
      ? `pipeline:${p.status}`
      : p.scope === "task"
        ? `task:${p.task_name}:${p.status}`
        : `step:${p.task_name}/${p.step_name}:${p.status}`,
  );
}

function logs(client: MockClient): string[] {
  return client.sendLogs.mock.calls.flatMap(([, entries]) =>
    (entries as { message: string }[]).map((e) => e.message),
  );
}

const ok: StepResult = { exitCode: 0, timedOut: false, cancelled: false };
const step = (name: string) => ({ name, command: `run ${name}` });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves only once the step's abort signal fires */
function hangUntilAborted(opts: StepExecutorOptions): Promise<StepResult> {
  return new Promise((resolve) => {
    opts.signal?.addEventListener("abort", () =>
      resolve({ exitCode: 1, timedOut: false, cancelled: true }),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executeStep).mockResolvedValue(ok);
  deployMock.mockResolvedValue({ success: true, publicUrl: "http://localhost:10000" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ── Tests ───────────────────────────────────────────────────────

describe("executePipeline — baseline", () => {
  it("runs tasks in DAG order and reports success", async () => {
    const client = createClient();
    await run(client, {
      build: { steps: [step("compile")] },
      ship: { depends_on: ["build"], steps: [step("push")] },
    });

    expect(statuses(client)).toEqual([
      "task:build:running",
      "step:build/compile:running",
      "step:build/compile:success",
      "task:build:success",
      "task:ship:running",
      "step:ship/push:running",
      "step:ship/push:success",
      "task:ship:success",
      "pipeline:success",
    ]);
  });

  it("skips downstream tasks when a step fails", async () => {
    vi.mocked(executeStep).mockResolvedValueOnce({ exitCode: 2, timedOut: false, cancelled: false });
    const client = createClient();
    await run(client, {
      build: { steps: [step("compile"), step("lint")] },
      ship: { depends_on: ["build"], steps: [step("push")] },
    });

    expect(statuses(client)).toEqual([
      "task:build:running",
      "step:build/compile:running",
      "step:build/compile:failed",
      "step:build/lint:skipped",
      "task:build:failed",
      "task:ship:skipped",
      "step:ship/push:skipped",
      "pipeline:failed",
    ]);
  });

  it("logs a clear timeout message and fails the step", async () => {
    vi.mocked(executeStep).mockResolvedValueOnce({ exitCode: 143, timedOut: true, cancelled: false });
    const client = createClient();
    await run(client, { build: { steps: [{ ...step("slow"), timeout_seconds: 30 }] } });

    expect(statuses(client)).toContain("step:build/slow:failed");
    expect(logs(client)).toContain("[step:slow] Timed out after 30s");
    expect(vi.mocked(executeStep)).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 30 }),
    );
  });

  it("passes resolved step env to the executor", async () => {
    const client = createClient();
    await run(client, {
      build: { steps: [{ ...step("env"), env: { SHA: "${{ git.short_sha }}", MODE: "ci" } }] },
    });

    expect(vi.mocked(executeStep)).toHaveBeenCalledWith(
      expect.objectContaining({ env: { SHA: "abcdef1", MODE: "ci" } }),
    );
  });
});

describe("executePipeline — cancellation", () => {
  it("kills the in-flight step and cancels the rest without touching pipeline status", async () => {
    const client = createClient({
      getRunStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({ status: "cancelled" }),
    });
    vi.mocked(executeStep).mockImplementation(hangUntilAborted);

    await run(client, {
      build: { steps: [step("compile"), step("test")] },
      ship: { depends_on: ["build"], steps: [step("push")] },
    });

    const reported = statuses(client);
    expect(vi.mocked(executeStep)).toHaveBeenCalledTimes(1);
    expect(reported).toEqual(
      expect.arrayContaining([
        "step:build/compile:cancelled",
        "step:build/test:cancelled",
        "task:build:cancelled",
        "step:ship/push:cancelled",
        "task:ship:cancelled",
      ]),
    );
    expect(reported.filter((s) => /:(skipped|failed)$/.test(s))).toEqual([]);
    expect(reported.filter((s) => s.startsWith("pipeline:"))).toEqual([]);
  });

  it("checks for cancellation between steps inside a task", async () => {
    const client = createClient({
      getRunStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({ status: "cancelled" }),
    });
    // The first step ignores the signal and completes after the cancel is seen
    vi.mocked(executeStep).mockImplementationOnce(async () => {
      await delay(50);
      return ok;
    });

    await run(client, { build: { steps: [step("compile"), step("test")] } });

    expect(vi.mocked(executeStep)).toHaveBeenCalledTimes(1);
    expect(statuses(client)).toEqual(
      expect.arrayContaining([
        "step:build/compile:success",
        "step:build/test:cancelled",
        "task:build:cancelled",
      ]),
    );
    expect(statuses(client)).not.toContain("pipeline:success");
  });
});

describe("executePipeline — approval gate", () => {
  it("waits for approval, then runs the task", async () => {
    const client = createClient({
      getApprovalStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: "pending" })
        .mockResolvedValueOnce({ status: "pending" })
        .mockResolvedValue({ status: "approved" }),
    });

    await run(client, { deploy: { approval_required: true, steps: [step("ship")] } });

    expect(statuses(client)).toEqual([
      "task:deploy:awaiting_approval",
      "task:deploy:running",
      "step:deploy/ship:running",
      "step:deploy/ship:success",
      "task:deploy:success",
      "pipeline:success",
    ]);
    expect(client.getApprovalStatus).toHaveBeenCalledWith("run-1", "deploy");
    expect(logs(client)).toContain("[task:deploy] Waiting for approval");
  });

  it("fails a rejected task, skips its steps and downstream tasks", async () => {
    const client = createClient({
      getApprovalStatus: vi.fn().mockResolvedValue({ status: "rejected" }),
    });

    await run(client, {
      deploy: { approval_required: true, steps: [step("ship"), step("verify")] },
      notify: { depends_on: ["deploy"], steps: [step("slack")] },
    });

    expect(vi.mocked(executeStep)).not.toHaveBeenCalled();
    expect(statuses(client)).toEqual([
      "task:deploy:awaiting_approval",
      "step:deploy/ship:skipped",
      "step:deploy/verify:skipped",
      "task:deploy:failed",
      "task:notify:skipped",
      "step:notify/slack:skipped",
      "pipeline:failed",
    ]);
    expect(logs(client).some((m) => m.includes("rejected by reviewer"))).toBe(true);
  });

  it("does not block sibling tasks in the same group", async () => {
    const order: string[] = [];
    let siblingDone = false;
    const client = createClient({
      getApprovalStatus: vi.fn(async () => ({ status: siblingDone ? "approved" : "pending" })),
    });
    vi.mocked(executeStep).mockImplementation(async (opts) => {
      order.push(opts.command);
      if (opts.command === "run test") siblingDone = true;
      return ok;
    });

    await run(client, {
      gated: { approval_required: true, steps: [step("ship")] },
      free: { steps: [step("test")] },
    });

    expect(order).toEqual(["run test", "run ship"]);
    expect(statuses(client)).toContain("pipeline:success");
  });

  it("stops waiting and cancels the task when the run is cancelled", async () => {
    const client = createClient({
      getApprovalStatus: vi.fn().mockResolvedValue({ status: "pending" }),
      getRunStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({ status: "cancelled" }),
    });

    await run(client, { deploy: { approval_required: true, steps: [step("ship")] } });

    expect(vi.mocked(executeStep)).not.toHaveBeenCalled();
    expect(statuses(client)).toEqual([
      "task:deploy:awaiting_approval",
      "step:deploy/ship:cancelled",
      "task:deploy:cancelled",
    ]);
  });

  it("keeps polling through transient approval errors", async () => {
    const client = createClient({
      getApprovalStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error("API error 503: unavailable"))
        .mockResolvedValue({ status: "approved" }),
    });

    await run(client, { deploy: { approval_required: true, steps: [step("ship")] } });

    expect(statuses(client)).toContain("task:deploy:success");
    expect(logs(client).some((m) => m.includes("API error 503"))).toBe(true);
  });
});

describe("executePipeline — artifacts", () => {
  it("uploads configured artifacts after the steps succeed", async () => {
    const client = createClient();
    await run(client, { build: { steps: [step("compile")], artifacts: ["dist/*.zip"] } });

    expect(vi.mocked(uploadTaskArtifacts)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        projectId: "proj-1",
        workspacePath: "/tmp/deployx-ws",
        patterns: ["dist/*.zip"],
        taskName: "build",
        taskRunId: "tr-build",
      }),
    );
  });

  it("does not upload when a step fails", async () => {
    vi.mocked(executeStep).mockResolvedValueOnce({ exitCode: 1, timedOut: false, cancelled: false });
    const client = createClient();
    await run(client, { build: { steps: [step("compile")], artifacts: ["dist/*.zip"] } });

    expect(vi.mocked(uploadTaskArtifacts)).not.toHaveBeenCalled();
  });
});

describe("executePipeline — image build for deployments", () => {
  const deployTask = (deploy: Record<string, unknown>): Tasks => ({
    release: { steps: [step("test")], deploy: { strategy: "blue_green", port: 3000, ...deploy } },
  });

  beforeEach(() => {
    vi.mocked(buildImage).mockImplementation(async (opts) => ({
      tags: opts.tags,
      digest: null,
      sizeBytes: 12345,
    }));
    vi.mocked(pushImage).mockResolvedValue("sha256:feedface");
  });

  it("builds a local image when deploy.image is absent and no registry is set", async () => {
    const client = createClient();
    await run(client, deployTask({ driver: "docker_local" }));

    expect(vi.mocked(buildImage)).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerfilePath: "Dockerfile",
        buildContext: ".",
        cwd: "/tmp/deployx-ws",
        tags: ["myapp:abcdef1"],
      }),
    );
    expect(vi.mocked(pushImage)).not.toHaveBeenCalled();
    expect(client.recordImage).toHaveBeenCalledWith("run-1", {
      registry: "local",
      repository: "myapp",
      tag: "abcdef1",
      size_bytes: 12345,
    });
    expect(client.createDeployment).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ image_tag: "myapp:abcdef1" }),
    );
    expect(statuses(client)).toContain("pipeline:success");
  });

  it("tags with and pushes to DEPLOYX_REGISTRY, recording the pushed digest", async () => {
    const client = createClient({
      getSecrets: vi.fn().mockResolvedValue({ DEPLOYX_REGISTRY: "ghcr.io/acme/" }),
    });
    await run(client, deployTask({ driver: "docker_local" }));

    expect(vi.mocked(buildImage)).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ["ghcr.io/acme/myapp:abcdef1", "ghcr.io/acme/myapp:main", "ghcr.io/acme/myapp:latest"],
      }),
    );
    expect(vi.mocked(pushImage)).toHaveBeenCalledTimes(3);
    expect(client.recordImage).toHaveBeenCalledWith("run-1", {
      registry: "ghcr.io",
      repository: "acme/myapp",
      tag: "abcdef1",
      digest: "sha256:feedface",
      size_bytes: 12345,
    });
    expect(client.createDeployment).toHaveBeenCalledWith("run-1", {
      strategy: "blue_green",
      deploy_target: "docker_local",
      image_tag: "ghcr.io/acme/myapp:abcdef1",
      image_digest: "sha256:feedface",
    });
  });

  it("keeps an explicit deploy.image and does not build", async () => {
    const client = createClient();
    await run(client, deployTask({ driver: "docker_local", image: "nginx:${{ git.short_sha }}" }));

    expect(vi.mocked(buildImage)).not.toHaveBeenCalled();
    expect(client.recordImage).not.toHaveBeenCalled();
    expect(client.createDeployment).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ image_tag: "nginx:abcdef1" }),
    );
  });

  it("fails an external deploy that would need a registry", async () => {
    const client = createClient();
    await run(client, deployTask({ driver: "railway" }));

    expect(vi.mocked(buildImage)).not.toHaveBeenCalled();
    expect(client.createDeployment).not.toHaveBeenCalled();
    expect(statuses(client)).toEqual(expect.arrayContaining(["task:release:failed", "pipeline:failed"]));
    expect(logs(client).some((m) => m.includes("DEPLOYX_REGISTRY"))).toBe(true);
  });

  it("fails when the image build fails", async () => {
    vi.mocked(buildImage).mockRejectedValue(new Error("Docker build failed with exit code 1"));
    const client = createClient();
    await run(client, deployTask({ driver: "docker_local" }));

    expect(client.createDeployment).not.toHaveBeenCalled();
    expect(statuses(client)).toContain("task:release:failed");
    expect(logs(client).some((m) => m.includes("Image build failed"))).toBe(true);
  });

  it("still deploys when recording the image fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createClient({ recordImage: vi.fn().mockRejectedValue(new Error("API error 500")) });
    await run(client, deployTask({ driver: "docker_local" }));

    expect(statuses(client)).toContain("pipeline:success");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to record built image"));
  });
});
