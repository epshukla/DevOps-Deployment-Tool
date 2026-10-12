import { z } from "zod";
import { DeployConfigSchema } from "./deployment";

// ── Step Config ─────────────────────────────────────────────────

export const StepConfigSchema = z.object({
  name: z
    .string()
    .min(1, "Step name is required")
    .max(128, "Step name must be at most 128 characters"),
  command: z
    .string()
    .min(1, "Step command is required")
    .max(4096, "Step command must be at most 4096 characters"),
  image: z.string().max(256).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout_seconds: z.number().int().positive().max(86400).optional(),
});

export type StepConfig = z.infer<typeof StepConfigSchema>;

// ── Artifacts ───────────────────────────────────────────────────

const ABSOLUTE_PATH_PATTERN = /^(?:[/\\~]|[A-Za-z]:)/;

/**
 * True if an artifact path/glob stays within the workspace: relative,
 * no ".." segments, no home-dir or negation prefix, no NUL bytes.
 * The runner re-checks resolved realpaths before uploading.
 */
export function isSafeArtifactPattern(pattern: string): boolean {
  if (pattern.includes("\0")) return false;
  if (ABSOLUTE_PATH_PATTERN.test(pattern)) return false;
  if (pattern.startsWith("!")) return false;
  return !pattern.split(/[/\\]/).some((segment) => segment === "..");
}

export const ArtifactPatternSchema = z
  .string()
  .min(1, "Artifact path is required")
  .max(500)
  .refine(isSafeArtifactPattern, {
    message: "Artifact paths must be relative to the workspace (no absolute paths or '..')",
  });

// ── Task Config ─────────────────────────────────────────────────

export const TaskConfigSchema = z.object({
  depends_on: z.array(z.string().min(1)).optional(),
  approval_required: z.boolean().optional(),
  steps: z
    .array(StepConfigSchema)
    .min(1, "Task must have at least one step")
    .max(50, "Task must have at most 50 steps"),
  deploy: DeployConfigSchema.optional(),
  /** Workspace-relative files/globs uploaded after the task's steps succeed */
  artifacts: z.array(ArtifactPatternSchema).max(20).optional(),
});

export type TaskConfig = z.infer<typeof TaskConfigSchema>;

// ── Pipeline Config (top-level deployx.yaml) ────────────────────

export const PipelineConfigSchema = z.object({
  name: z
    .string()
    .min(1, "Pipeline name is required")
    .max(128, "Pipeline name must be at most 128 characters"),
  tasks: z
    .record(
      z
        .string()
        .min(1)
        .max(64)
        .regex(
          /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
          "Task name must start with alphanumeric and contain only letters, numbers, hyphens, underscores",
        ),
      TaskConfigSchema,
    )
    .refine(
      (tasks) => Object.keys(tasks).length >= 1,
      "Pipeline must have at least one task",
    )
    .refine(
      (tasks) => Object.keys(tasks).length <= 100,
      "Pipeline must have at most 100 tasks",
    ),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
