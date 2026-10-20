import { describe, it, expect } from "vitest";
import { HeartbeatSchema, RunnerMetricsSchema } from "../runner";

const metrics = {
  cpu_percent: 37.5,
  load_1m: 1.2,
  cpu_count: 8,
  memory_used_mb: 12_288,
  memory_total_mb: 15_872,
  disk_used_gb: 120.4,
  disk_total_gb: 476.9,
  containers_running: 9,
  docker_cpu_percent: 2.1,
  docker_memory_mb: 640,
};

describe("RunnerMetricsSchema", () => {
  it("accepts a full sample", () => {
    expect(RunnerMetricsSchema.safeParse(metrics).success).toBe(true);
  });

  it("allows unknown disk and Docker usage", () => {
    const sample = { ...metrics, disk_used_gb: null, disk_total_gb: null, docker_cpu_percent: null, docker_memory_mb: null };
    expect(RunnerMetricsSchema.safeParse(sample).success).toBe(true);
  });

  it.each([
    ["cpu over 100%", { cpu_percent: 140 }],
    ["negative memory", { memory_used_mb: -1 }],
    ["fractional container count", { containers_running: 1.5 }],
    ["NaN load", { load_1m: Number.NaN }],
  ])("rejects %s", (_label, override) => {
    expect(RunnerMetricsSchema.safeParse({ ...metrics, ...override }).success).toBe(false);
  });
});

describe("HeartbeatSchema", () => {
  it("still accepts an empty heartbeat (older runners)", () => {
    expect(HeartbeatSchema.safeParse({}).success).toBe(true);
  });

  it("accepts metrics", () => {
    expect(HeartbeatSchema.safeParse({ metrics }).success).toBe(true);
  });
});
