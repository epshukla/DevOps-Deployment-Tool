import type { DeployConfig } from "@deployx/shared";
import type { VolumeMount } from "./container-manager";

/**
 * How an app container runs beyond its image: persistent named volumes and
 * cgroup limits from the deploy config. Stored as a label on the container
 * so self-healing can recreate it identically from Docker state alone.
 */
export interface AppRuntime {
  readonly volumes: readonly VolumeMount[];
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly pidsLimit?: number;
}

export const RUNTIME_LABEL = "deployx.runtime";

/** Docker volume holding a project's named volume: deployx-<slug>-vol-<name> */
export function projectVolumeName(projectSlug: string, name: string): string {
  return `deployx-${projectSlug}-vol-${name}`;
}

export function appRuntimeFromConfig(
  config: Pick<DeployConfig, "volumes" | "resources">,
  projectSlug: string,
): AppRuntime {
  return {
    volumes: (config.volumes ?? []).map((v) => ({
      source: projectVolumeName(projectSlug, v.name),
      target: v.path,
      readOnly: v.read_only ?? false,
    })),
    cpus: config.resources?.cpus,
    memoryMb: config.resources?.memory_mb,
    pidsLimit: config.resources?.pids,
  };
}

export function withRuntimeLabel(
  labels: Readonly<Record<string, string>>,
  runtime: AppRuntime,
): Record<string, string> {
  const empty =
    runtime.volumes.length === 0 &&
    runtime.cpus == null &&
    runtime.memoryMb == null &&
    runtime.pidsLimit == null;
  return empty ? { ...labels } : { ...labels, [RUNTIME_LABEL]: JSON.stringify(runtime) };
}

/** Read the runtime back from a container's labels (empty when absent or bad). */
export function runtimeFromLabels(labels: Readonly<Record<string, string>> | undefined): AppRuntime {
  const raw = labels?.[RUNTIME_LABEL];
  if (!raw) return { volumes: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<AppRuntime>;
    const volumes = Array.isArray(parsed.volumes)
      ? parsed.volumes.filter(
          (v): v is VolumeMount =>
            typeof v?.source === "string" &&
            v.source.startsWith("deployx-") &&
            typeof v?.target === "string" &&
            v.target.startsWith("/"),
        )
      : [];
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
    return {
      volumes,
      cpus: num(parsed.cpus),
      memoryMb: num(parsed.memoryMb),
      pidsLimit: num(parsed.pidsLimit),
    };
  } catch {
    return { volumes: [] };
  }
}
