import { z } from "zod";

// ── Health Check Config (embedded in deploy YAML) ──────────────

export const HealthCheckConfigSchema = z.object({
  path: z.string().min(1).default("/health"),
  interval_seconds: z.number().int().positive().max(300).default(10),
  timeout_seconds: z.number().int().positive().max(60).default(5),
  retries: z.number().int().positive().max(20).default(3),
  start_period_seconds: z.number().int().nonnegative().max(300).default(15),
});

export type HealthCheckConfig = z.infer<typeof HealthCheckConfigSchema>;

// ── Canary Config ───────────────────────────────────────────────

export const CanaryConfigSchema = z.object({
  stages: z
    .array(z.number().int().min(1).max(100))
    .min(1)
    .max(10)
    .default([10, 25, 50, 100]),
  observation_seconds: z.number().int().positive().max(600).default(30),
});

export type CanaryConfig = z.infer<typeof CanaryConfigSchema>;

// ── Rolling Config ──────────────────────────────────────────────

export const RollingConfigSchema = z.object({
  instances: z.number().int().min(2).max(10).default(2),
  max_unavailable: z.number().int().min(1).max(5).default(1),
  observation_seconds: z.number().int().positive().max(600).default(15),
});

export type RollingConfig = z.infer<typeof RollingConfigSchema>;

// ── Railway Config ──────────────────────────────────────────────

export const RailwayConfigSchema = z.object({
  project_id: z.string().max(256).optional(),
  region: z.string().max(64).optional(),
});

export type RailwayConfig = z.infer<typeof RailwayConfigSchema>;

// ── Fly.io Config ──────────────────────────────────────────────

export const FlyConfigSchema = z.object({
  app_name: z.string().max(256).optional(),
  region: z.string().max(64).default("iad"),
  vm_size: z
    .enum([
      "shared-cpu-1x",
      "shared-cpu-2x",
      "shared-cpu-4x",
      "performance-1x",
      "performance-2x",
    ])
    .default("shared-cpu-1x"),
});

export type FlyConfig = z.infer<typeof FlyConfigSchema>;

// ── Resources & Volumes (docker_local) ──────────────────────────

/** Per-container limits (cgroups): CPU share, memory cap, process cap. */
export const ResourceLimitsSchema = z.object({
  /** CPUs the container may use, e.g. 0.5 = half a core */
  cpus: z.number().min(0.05).max(64).optional(),
  memory_mb: z.number().int().min(32).max(262_144).optional(),
  pids: z.number().int().min(16).max(65_536).optional(),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

/**
 * A persistent named volume (block storage for the app): it outlives
 * redeploys, colour switches and restarts, and is shared by every instance
 * of the project. Host paths are deliberately not allowed.
 */
export const VolumeConfigSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Volume name: lowercase letters, digits and hyphens (max 32)"),
  path: z
    .string()
    .max(256)
    .regex(/^\/[A-Za-z0-9._/-]*$/, "Mount path must be an absolute path")
    .refine((p) => p !== "/" && !p.split("/").includes(".."), "Mount path must not be / or contain ..")
    .refine(
      (p) => !["/proc", "/sys", "/dev", "/etc", "/bin", "/sbin", "/usr", "/lib"].some(
        (bad) => p === bad || p.startsWith(`${bad}/`),
      ),
      "Mount path must not be a system directory",
    ),
  read_only: z.boolean().default(false),
});

export type VolumeConfig = z.infer<typeof VolumeConfigSchema>;

// ── Deploy Config (task-level in deployx.yaml) ─────────────────

export const DeployConfigSchema = z.object({
  driver: z.enum(["docker_local", "railway", "fly_io"]),
  strategy: z
    .enum(["blue_green", "canary", "rolling"])
    .default("blue_green"),
  port: z.number().int().positive().max(65535).default(3000),
  image: z.string().max(256).optional(),
  health_check: HealthCheckConfigSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  canary: CanaryConfigSchema.optional(),
  rolling: RollingConfigSchema.optional(),
  railway: RailwayConfigSchema.optional(),
  fly: FlyConfigSchema.optional(),
  /**
   * docker_local only: expose the deployment on a temporary public HTTPS URL
   * through a Cloudflare quick tunnel (removed after PUBLIC_URL_TTL_HOURS).
   * Defaults to on; set false to keep the app on localhost only.
   */
  public_url: z.boolean().default(true),
  /** docker_local only: cgroup limits for each app container */
  resources: ResourceLimitsSchema.optional(),
  /** docker_local only: named volumes that persist across deploys */
  volumes: z
    .array(VolumeConfigSchema)
    .max(5)
    .refine((vs) => new Set(vs.map((v) => v.name)).size === vs.length, "Volume names must be unique")
    .refine((vs) => new Set(vs.map((v) => v.path)).size === vs.length, "Mount paths must be unique")
    .optional(),
});

export type DeployConfig = z.infer<typeof DeployConfigSchema>;

// ── Runner → Control Plane: Create Deployment ──────────────────

export const CreateDeploymentSchema = z.object({
  strategy: z.enum(["blue_green", "canary", "rolling"]),
  deploy_target: z.enum(["docker_local", "railway", "fly_io"]),
  image_tag: z.string().min(1).max(256),
  image_digest: z.string().max(256).optional(),
});

export type CreateDeploymentPayload = z.infer<typeof CreateDeploymentSchema>;

// ── Runner → Control Plane: Update Deployment Status ───────────

export const UpdateDeploymentSchema = z.object({
  status: z.enum([
    "pending",
    "deploying",
    "active",
    "draining",
    "stopped",
    "rolled_back",
    "failed",
  ]),
  health_status: z
    .enum(["healthy", "degraded", "unhealthy", "unknown"])
    .optional(),
  /** Temporary public URL (https only) and when it stops working. */
  public_url: z
    .string()
    .url()
    .max(512)
    .refine((u) => u.startsWith("https://"), "Public URL must use https")
    .nullable()
    .optional(),
  public_url_expires_at: z.string().datetime().nullable().optional(),
});

export type UpdateDeploymentPayload = z.infer<typeof UpdateDeploymentSchema>;

// ── Runner → Control Plane: Record Health Check ────────────────

export const RecordHealthCheckSchema = z.object({
  status: z.enum(["pass", "fail"]),
  response_time_ms: z.number().int().nonnegative().optional(),
  status_code: z.number().int().optional(),
  error_message: z.string().max(4096).optional(),
});

export type RecordHealthCheckPayload = z.infer<typeof RecordHealthCheckSchema>;

// ── Runner → Control Plane: Record Healing Event ──────────────

export const RecordHealingEventSchema = z.object({
  event_type: z.enum([
    "health_degraded",
    "health_unhealthy",
    "restart_started",
    "restart_succeeded",
    "restart_failed",
    "rollback_started",
    "rollback_succeeded",
    "rollback_failed",
    "canary_promotion",
    "canary_rollback",
    "rolling_instance_updated",
    "rolling_rollback",
    "blue_green_cutover",
  ]),
  attempt_number: z.number().int().nonnegative().optional(),
  container_name: z.string().max(256).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type RecordHealingEventPayload = z.infer<typeof RecordHealingEventSchema>;
