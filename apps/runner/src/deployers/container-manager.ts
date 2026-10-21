import { execa } from "execa";

// ── Types ───────────────────────────────────────────────────────

export interface PortMapping {
  readonly host: number;
  readonly container: number;
  /** Bind on this host address only (e.g. 127.0.0.1); default all interfaces */
  readonly hostIp?: string;
}

export interface VolumeMount {
  /** Named Docker volume (created on first use) or absolute host path */
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface RunContainerOptions {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  readonly ports?: readonly PortMapping[];
  readonly env?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly detach: boolean;
  readonly restart?: "no" | "always" | "unless-stopped";
  /** Arguments passed to the image's entrypoint (after the image name). */
  readonly command?: readonly string[];
  readonly volumes?: readonly VolumeMount[];
  /** cgroup limits: CPU share (cores), memory cap (MiB, no extra swap), process cap */
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly pidsLimit?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ContainerInspection {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ContainerInfo {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly image: string;
}

// ── Network Management ──────────────────────────────────────────

export async function ensureNetwork(name: string): Promise<void> {
  const inspect = await execa("docker", ["network", "inspect", name], {
    reject: false,
  });
  if (inspect.exitCode === 0) return;

  const create = await execa("docker", ["network", "create", name], {
    reject: false,
  });
  if (create.exitCode === 0) return;

  // Another deploy may have created the network between inspect and create
  if (create.stderr.includes("already exists")) return;

  throw new Error(`Failed to create network ${name}: ${create.stderr}`);
}

// ── Container Lifecycle ─────────────────────────────────────────

export async function runContainer(
  options: RunContainerOptions,
): Promise<string> {
  const args = ["run"];

  if (options.detach) args.push("-d");

  args.push("--name", options.name);
  args.push("--network", options.network);

  if (options.restart) {
    args.push("--restart", options.restart);
  }

  if (options.ports) {
    for (const pm of options.ports) {
      args.push("-p", `${pm.hostIp ? `${pm.hostIp}:` : ""}${pm.host}:${pm.container}`);
    }
  }

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  if (options.labels) {
    for (const [key, value] of Object.entries(options.labels)) {
      args.push("--label", `${key}=${value}`);
    }
  }

  if (options.volumes) {
    for (const v of options.volumes) {
      args.push("-v", `${v.source}:${v.target}${v.readOnly ? ":ro" : ""}`);
    }
  }

  if (options.cpus != null) args.push("--cpus", String(options.cpus));
  if (options.memoryMb != null) {
    args.push("--memory", `${options.memoryMb}m`, "--memory-swap", `${options.memoryMb}m`);
  }
  if (options.pidsLimit != null) args.push("--pids-limit", String(options.pidsLimit));

  args.push(options.image);

  if (options.command) {
    args.push(...options.command);
  }

  const result = await execa("docker", args);
  return result.stdout.trim();
}

export async function stopContainer(
  name: string,
  timeoutSeconds = 10,
): Promise<void> {
  const result = await execa(
    "docker",
    ["stop", "-t", String(timeoutSeconds), name],
    { reject: false },
  );

  if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
    throw new Error(`Failed to stop container ${name}: ${result.stderr}`);
  }
}

export async function removeContainer(name: string): Promise<void> {
  const result = await execa("docker", ["rm", "-f", name], { reject: false });

  if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
    throw new Error(`Failed to remove container ${name}: ${result.stderr}`);
  }
}

export async function restartContainer(
  name: string,
  timeoutSeconds = 10,
): Promise<void> {
  const result = await execa(
    "docker",
    ["restart", "-t", String(timeoutSeconds), name],
    { reject: false },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to restart container ${name}: ${result.stderr}`);
  }
}

/**
 * Run a throwaway container to completion (`docker run --rm`), e.g. to
 * prepare volumes. Throws on a non-zero exit.
 */
export async function runOnce(options: {
  readonly image: string;
  readonly entrypoint: string;
  readonly command: readonly string[];
  readonly user?: string;
  readonly volumes?: readonly VolumeMount[];
}): Promise<void> {
  const args = ["run", "--rm", "--entrypoint", options.entrypoint];
  if (options.user) args.push("--user", options.user);
  for (const v of options.volumes ?? []) {
    args.push("-v", `${v.source}:${v.target}${v.readOnly ? ":ro" : ""}`);
  }
  args.push(options.image, ...options.command);
  const result = await execa("docker", args, { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`docker run ${options.image} failed: ${result.stderr}`);
  }
}

/** Run a command inside a running container. Never throws on a non-zero exit. */
export async function execInContainer(
  name: string,
  command: readonly string[],
): Promise<ExecResult> {
  const result = await execa("docker", ["exec", name, ...command], { reject: false });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** Copy a host file into a container (`docker cp`). */
export async function copyToContainer(
  name: string,
  hostPath: string,
  containerPath: string,
): Promise<void> {
  const result = await execa("docker", ["cp", hostPath, `${name}:${containerPath}`], {
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to copy ${hostPath} into ${name}: ${result.stderr}`);
  }
}

// ── Container Inspection ────────────────────────────────────────

export async function inspectContainer(
  name: string,
): Promise<ContainerInspection | null> {
  const result = await execa(
    "docker",
    ["inspect", "--format", "json", name],
    { reject: false },
  );

  if (result.exitCode !== 0) return null;

  try {
    const data = JSON.parse(result.stdout);
    const container = Array.isArray(data) ? data[0] : data;
    return {
      id: container.Id ?? "",
      name: (container.Name ?? "").replace(/^\//, ""),
      state: container.State?.Status ?? "unknown",
      image: container.Config?.Image ?? "",
      labels: container.Config?.Labels ?? {},
    };
  } catch {
    return null;
  }
}

export async function isContainerRunning(name: string): Promise<boolean> {
  const inspection = await inspectContainer(name);
  return inspection?.state === "running";
}

export async function getContainerLogs(
  name: string,
  tail = 100,
): Promise<readonly string[]> {
  const result = await execa(
    "docker",
    ["logs", "--tail", String(tail), name],
    { reject: false },
  );

  if (result.exitCode !== 0) return [];

  const combined = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n");

  return combined.split("\n").filter(Boolean);
}

// ── Container Discovery ─────────────────────────────────────────

export async function listContainersByLabel(
  label: string,
): Promise<readonly ContainerInfo[]> {
  const result = await execa(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=${label}`,
      "--format",
      "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}",
    ],
    { reject: false },
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [id, name, status, image] = line.split("\t");
      return { id, name, status, image };
    });
}

// ── Cleanup Helpers ─────────────────────────────────────────────

export async function removeContainerIfExists(name: string): Promise<void> {
  const exists = await inspectContainer(name);
  if (exists) {
    await stopContainer(name, 5);
    await removeContainer(name);
  }
}
