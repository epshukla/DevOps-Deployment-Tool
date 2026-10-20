import { readFile, statfs } from "node:fs/promises";
import { cpus, loadavg, tmpdir, totalmem, freemem } from "node:os";
import { execa } from "execa";
import type { RunnerMetrics } from "@deployx/shared";

/**
 * Host and Docker resource usage, sampled by the runner and sent with its
 * heartbeat so the dashboard can show how loaded each machine is.
 */

export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

export interface DockerUsage {
  readonly containers: number;
  readonly cpuPercent: number;
  readonly memoryMb: number;
}

/** OS / Docker reads, injectable for tests. */
export interface MetricsDeps {
  readonly cpuTimes: () => CpuTimes;
  readonly cpuCount: () => number;
  readonly loadAvg1m: () => number;
  readonly totalMemMb: () => number;
  readonly availableMemMb: () => Promise<number>;
  readonly disk: () => Promise<{ usedGb: number; totalGb: number } | null>;
  readonly dockerUsage: () => Promise<DockerUsage | null>;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Busy share of CPU time between two cumulative samples, 0–100. */
export function cpuPercentBetween(prev: CpuTimes, next: CpuTimes): number {
  const total = next.total - prev.total;
  if (total <= 0) return 0;
  const busy = total - (next.idle - prev.idle);
  return round1(Math.min(100, Math.max(0, (busy / total) * 100)));
}

/** MemAvailable from /proc/meminfo (counts reclaimable cache as free). */
export function parseMemAvailableMb(meminfo: string): number | null {
  const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  return match ? Math.round(Number(match[1]) / 1024) : null;
}

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
  KIB: 1024, MIB: MB, GIB: GB, TIB: GB * 1024,
};

/** "45.3MiB" / "1.5GiB" / "2GB" → megabytes (MiB). */
export function parseSizeToMb(value: string): number {
  const match = value.trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/);
  if (!match) return 0;
  const bytes = Number(match[1]) * (UNIT_BYTES[match[2].toUpperCase()] ?? 0);
  return round1(bytes / MB);
}

/** Sum `docker stats` lines formatted as "CPUPerc;MemUsage". */
export function parseDockerStats(output: string): { cpuPercent: number; memoryMb: number } {
  let cpuPercent = 0;
  let memoryMb = 0;
  for (const line of output.split("\n")) {
    const [cpu, mem] = line.split(";");
    if (!cpu || !mem) continue;
    cpuPercent += Number.parseFloat(cpu) || 0;
    memoryMb += parseSizeToMb(mem.split("/")[0] ?? "");
  }
  return { cpuPercent: round1(cpuPercent), memoryMb: round1(memoryMb) };
}

function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

async function readDockerUsage(): Promise<DockerUsage | null> {
  const ps = await execa("docker", ["ps", "-q", "--filter", "label=deployx.project"], {
    reject: false,
  });
  if (ps.exitCode !== 0) return null;
  const ids = ps.stdout.split("\n").filter(Boolean);
  if (ids.length === 0) return { containers: 0, cpuPercent: 0, memoryMb: 0 };

  const stats = await execa(
    "docker",
    ["stats", "--no-stream", "--format", "{{.CPUPerc}};{{.MemUsage}}", ...ids],
    { reject: false },
  );
  if (stats.exitCode !== 0) return { containers: ids.length, cpuPercent: 0, memoryMb: 0 };
  return { containers: ids.length, ...parseDockerStats(stats.stdout) };
}

const defaultDeps: MetricsDeps = {
  cpuTimes: readCpuTimes,
  cpuCount: () => cpus().length,
  loadAvg1m: () => round1(loadavg()[0] ?? 0),
  totalMemMb: () => Math.round(totalmem() / MB),
  availableMemMb: async () => {
    // freemem() treats page cache as used on Linux, which overstates usage
    const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => null);
    const available = meminfo ? parseMemAvailableMb(meminfo) : null;
    return available ?? Math.round(freemem() / MB);
  },
  disk: async () => {
    // The filesystem workspaces are cloned into
    const fs = await statfs(tmpdir()).catch(() => null);
    if (!fs) return null;
    const total = fs.blocks * fs.bsize;
    const used = total - fs.bavail * fs.bsize;
    return { usedGb: round1(used / GB), totalGb: round1(total / GB) };
  },
  dockerUsage: () => readDockerUsage().catch(() => null),
};

/**
 * Returns a function that takes one sample. CPU usage is measured over the
 * interval since the previous call (the first call covers time since boot).
 */
export function createMetricsSampler(deps: MetricsDeps = defaultDeps): () => Promise<RunnerMetrics> {
  let previous = deps.cpuTimes();

  return async () => {
    const current = deps.cpuTimes();
    const cpuPercent = cpuPercentBetween(previous, current);
    previous = current;

    const [availableMb, disk, docker] = await Promise.all([
      deps.availableMemMb(),
      deps.disk(),
      deps.dockerUsage(),
    ]);
    const totalMb = deps.totalMemMb();

    return {
      cpu_percent: cpuPercent,
      load_1m: deps.loadAvg1m(),
      cpu_count: deps.cpuCount(),
      memory_used_mb: Math.max(0, totalMb - availableMb),
      memory_total_mb: totalMb,
      disk_used_gb: disk?.usedGb ?? null,
      disk_total_gb: disk?.totalGb ?? null,
      containers_running: docker?.containers ?? 0,
      docker_cpu_percent: docker?.cpuPercent ?? null,
      docker_memory_mb: docker?.memoryMb ?? null,
    };
  };
}

/**
 * Heartbeats run every 10s but metrics are sampled less often: returns a
 * fresh sample once per `intervalMs`, otherwise undefined. A failed sample is
 * skipped rather than failing the heartbeat.
 */
export function createHeartbeatMetrics(
  sample: () => Promise<RunnerMetrics>,
  intervalMs: number,
  now: () => number = Date.now,
): () => Promise<RunnerMetrics | undefined> {
  let lastSampledAt = Number.NEGATIVE_INFINITY;
  return async () => {
    if (now() - lastSampledAt < intervalMs) return undefined;
    lastSampledAt = now();
    try {
      return await sample();
    } catch {
      return undefined;
    }
  };
}
