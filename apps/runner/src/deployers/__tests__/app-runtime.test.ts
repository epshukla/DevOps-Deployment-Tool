import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appRuntimeFromConfig,
  projectVolumeName,
  runtimeFromLabels,
  withRuntimeLabel,
  RUNTIME_LABEL,
} from "../app-runtime";
import { runContainer } from "../container-manager";

vi.mock("execa", () => ({ execa: vi.fn() }));

describe("appRuntimeFromConfig", () => {
  it("maps named volumes to per-project Docker volumes and copies limits", () => {
    const runtime = appRuntimeFromConfig(
      {
        volumes: [{ name: "data", path: "/var/www/html", read_only: false }],
        resources: { cpus: 0.5, memory_mb: 512, pids: 256 },
      },
      "my-app",
    );
    expect(runtime).toEqual({
      volumes: [{ source: "deployx-my-app-vol-data", target: "/var/www/html", readOnly: false }],
      cpus: 0.5,
      memoryMb: 512,
      pidsLimit: 256,
    });
    expect(projectVolumeName("my-app", "data")).toBe("deployx-my-app-vol-data");
  });

  it("is empty without config", () => {
    expect(appRuntimeFromConfig({}, "x")).toEqual({ volumes: [] });
  });
});

describe("runtime label", () => {
  it("round-trips through container labels", () => {
    const runtime = appRuntimeFromConfig(
      { volumes: [{ name: "d", path: "/data", read_only: true }], resources: { memory_mb: 256 } },
      "p",
    );
    const labels = withRuntimeLabel({ a: "b" }, runtime);
    expect(labels.a).toBe("b");
    expect(runtimeFromLabels(labels)).toEqual(runtime);
  });

  it("adds no label when there is nothing to record", () => {
    expect(withRuntimeLabel({ a: "b" }, { volumes: [] })).toEqual({ a: "b" });
  });

  it("ignores malformed or foreign volume entries", () => {
    const labels = {
      [RUNTIME_LABEL]: JSON.stringify({
        volumes: [{ source: "/etc", target: "/host" }, { source: "deployx-p-vol-x", target: "/x" }],
        cpus: "lots",
      }),
    };
    expect(runtimeFromLabels(labels)).toEqual({
      volumes: [{ source: "deployx-p-vol-x", target: "/x" }],
      cpus: undefined,
      memoryMb: undefined,
      pidsLimit: undefined,
    });
    expect(runtimeFromLabels({ [RUNTIME_LABEL]: "{not json" })).toEqual({ volumes: [] });
  });
});

describe("runContainer with runtime options", () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExeca = (await import("execa")).execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "id\n", stderr: "" });
  });

  it("passes volumes, cgroup limits and loopback port bindings to docker", async () => {
    await runContainer({
      name: "c",
      image: "img",
      network: "n",
      detach: true,
      ports: [{ hostIp: "127.0.0.1", host: 19000, container: 9000 }],
      volumes: [{ source: "v", target: "/data", readOnly: true }],
      cpus: 0.5,
      memoryMb: 512,
      pidsLimit: 128,
    });
    const args = mockExeca.mock.calls[0][1] as string[];
    expect(args.join(" ")).toContain("-p 127.0.0.1:19000:9000");
    expect(args.join(" ")).toContain("-v v:/data:ro");
    expect(args.join(" ")).toContain("--cpus 0.5");
    expect(args.join(" ")).toContain("--memory 512m --memory-swap 512m");
    expect(args.join(" ")).toContain("--pids-limit 128");
    expect(args.indexOf("img")).toBeGreaterThan(args.indexOf("--pids-limit"));
  });
});
