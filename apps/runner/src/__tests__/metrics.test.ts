import { describe, it, expect } from "vitest";
import {
  cpuPercentBetween,
  parseMemAvailableMb,
  parseDockerStats,
  parseSizeToMb,
  createMetricsSampler,
  createHeartbeatMetrics,
  type CpuTimes,
  type MetricsDeps,
} from "../metrics";

const times = (idle: number, busy: number): CpuTimes => ({ idle, total: idle + busy });

describe("cpuPercentBetween", () => {
  it("is the busy share of the time elapsed between samples", () => {
    expect(cpuPercentBetween(times(1000, 1000), times(1300, 1700))).toBe(70);
  });

  it("is 0 when no time passed", () => {
    expect(cpuPercentBetween(times(10, 10), times(10, 10))).toBe(0);
  });
});

describe("parseMemAvailableMb", () => {
  it("reads MemAvailable (page cache counts as free)", () => {
    const meminfo = "MemTotal:       16252928 kB\nMemFree:         1258291 kB\nMemAvailable:    2831155 kB\n";
    expect(parseMemAvailableMb(meminfo)).toBe(2765);
  });

  it("returns null when the field is missing", () => {
    expect(parseMemAvailableMb("MemTotal: 1 kB")).toBeNull();
  });
});

describe("parseSizeToMb", () => {
  it.each([
    ["45.3MiB", 45.3],
    ["1.5GiB", 1536],
    ["512KiB", 0.5],
    ["980B", 0],
    ["2GB", 1907.3],
  ])("%s → %d MB", (input, expected) => {
    expect(parseSizeToMb(input)).toBeCloseTo(expected, 1);
  });
});

describe("parseDockerStats", () => {
  it("sums CPU and memory across containers", () => {
    const out = "0.52%;45.3MiB / 15.5GiB\n1.48%;1.5GiB / 15.5GiB\n";
    expect(parseDockerStats(out)).toEqual({ cpuPercent: 2, memoryMb: 1581.3 });
  });

  it("is zero with no containers", () => {
    expect(parseDockerStats("")).toEqual({ cpuPercent: 0, memoryMb: 0 });
  });
});

function fakeDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps {
  let call = 0;
  return {
    cpuTimes: () => (call++ === 0 ? times(1000, 1000) : times(1100, 1300)),
    cpuCount: () => 8,
    loadAvg1m: () => 1.25,
    totalMemMb: () => 16_000,
    availableMemMb: async () => 4_000,
    disk: async () => ({ usedGb: 100, totalGb: 400 }),
    dockerUsage: async () => ({ containers: 3, cpuPercent: 1.5, memoryMb: 300 }),
    ...overrides,
  };
}

describe("createMetricsSampler", () => {
  it("measures CPU since the previous sample and reports host + Docker usage", async () => {
    const sample = createMetricsSampler(fakeDeps());
    expect(await sample()).toEqual({
      cpu_percent: 75,
      load_1m: 1.25,
      cpu_count: 8,
      memory_used_mb: 12_000,
      memory_total_mb: 16_000,
      disk_used_gb: 100,
      disk_total_gb: 400,
      containers_running: 3,
      docker_cpu_percent: 1.5,
      docker_memory_mb: 300,
    });
  });

  it("degrades to nulls when disk or Docker can't be read", async () => {
    const sample = createMetricsSampler(
      fakeDeps({ disk: async () => null, dockerUsage: async () => null }),
    );
    const m = await sample();
    expect(m.disk_used_gb).toBeNull();
    expect(m.containers_running).toBe(0);
    expect(m.docker_memory_mb).toBeNull();
  });

  it("caps CPU at 100 even if the clock math overshoots", async () => {
    let call = 0;
    const sample = createMetricsSampler(
      fakeDeps({ cpuTimes: () => (call++ === 0 ? times(100, 0) : times(90, 500)) }),
    );
    expect((await sample()).cpu_percent).toBe(100);
  });
});

describe("createHeartbeatMetrics", () => {
  const m = { cpu_percent: 1 } as unknown as Awaited<ReturnType<ReturnType<typeof createMetricsSampler>>>;

  it("samples at most once per interval", async () => {
    let t = 0;
    let calls = 0;
    const next = createHeartbeatMetrics(async () => (calls++, m), 30_000, () => t);
    expect(await next()).toBe(m);
    t = 10_000;
    expect(await next()).toBeUndefined();
    t = 30_000;
    expect(await next()).toBe(m);
    expect(calls).toBe(2);
  });

  it("skips a failed sample instead of throwing", async () => {
    const next = createHeartbeatMetrics(async () => {
      throw new Error("docker down");
    }, 30_000);
    await expect(next()).resolves.toBeUndefined();
  });
});
