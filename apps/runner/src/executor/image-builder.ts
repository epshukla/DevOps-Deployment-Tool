import { isAbsolute, relative, resolve } from "node:path";
import { buildImage, pushImage, generateTags } from "../docker/docker-client";
import { resolveVariables } from "./variable-resolver";
import { isValidImageRef } from "./step-executor";
import type { RunContext } from "./task-executor";
import type { DeploymentRequest } from "./deployment-executor";

/**
 * Registry prefix to push built images to (e.g. "ghcr.io/acme"), read from
 * project secrets or the runner's environment. Unset → images stay local.
 */
export const REGISTRY_ENV_VAR = "DEPLOYX_REGISTRY";

/** Registry value recorded for images that were never pushed */
const LOCAL_REGISTRY = "local";

export interface ResolvedImage {
  readonly imageTag: string;
  readonly digest: string | null;
}

/**
 * Returns the image to deploy: the config's `image` (with ${{ }} resolved),
 * or — when none is given — one built from the job's Dockerfile, pushed if a
 * registry is configured, and recorded with the control plane.
 * Returns null (after logging why) if no image could be produced.
 */
export async function resolveDeployImage(
  run: RunContext,
  request: DeploymentRequest,
): Promise<ResolvedImage | null> {
  const { image } = request.deployConfig;
  if (image) {
    return { imageTag: resolveVariables(image, run.variableContext), digest: null };
  }
  return buildDeployImage(run, request);
}

async function buildDeployImage(
  run: RunContext,
  request: DeploymentRequest,
): Promise<ResolvedImage | null> {
  const { job, variableContext } = run;
  const fail = (message: string): null => {
    logDeploy(run, request, "error", message);
    return null;
  };

  if (!run.dockerAvailable) {
    return fail("Docker is required to build an image (no deploy.image configured)");
  }

  const paths = resolveBuildPaths(run.workspacePath, job.dockerfile_path, job.build_context);
  if (!paths) {
    return fail(`Dockerfile path "${job.dockerfile_path}" / build context "${job.build_context}" must stay within the workspace`);
  }

  const registry = parseRegistry(variableContext.env[REGISTRY_ENV_VAR]);
  if (!registry && request.deployConfig.driver !== "docker_local") {
    return fail(`${request.deployConfig.driver} needs a pushed image: set ${REGISTRY_ENV_VAR} (e.g. ghcr.io/acme) or deploy.image`);
  }

  const tags = registry
    ? generateTags(registry.prefix, job.project_slug, variableContext.git.sha, job.git_branch)
    : [`${job.project_slug}:${variableContext.git.short_sha}`];
  if (!tags.every(isValidImageRef)) {
    return fail(`Invalid image tag(s): ${tags.join(", ")}`);
  }

  logDeploy(run, request, "info", `Building image ${tags[0]} from ${paths.dockerfile}`);
  try {
    const build = await buildImage({
      dockerfilePath: paths.dockerfile,
      buildContext: paths.context,
      cwd: run.workspacePath,
      tags,
      logStreamer: run.logStreamer,
      taskRunId: request.taskRunId,
    });

    const pushedDigest = registry ? await pushTags(run, request, tags) : null;
    if (registry && pushedDigest === null && request.deployConfig.driver !== "docker_local") {
      return fail(`Pushing ${tags[0]} failed — ${request.deployConfig.driver} can't pull the image`);
    }

    const digest = pushedDigest ?? build.digest;
    await recordBuiltImage(run, registry, { digest, sizeBytes: build.sizeBytes });
    return { imageTag: tags[0], digest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Image build failed: ${msg}`);
  }
}

/**
 * Pushes every tag (registry credentials come from the host's `docker login`).
 * Returns the primary tag's remote digest, or null if that push failed.
 */
async function pushTags(
  run: RunContext,
  request: DeploymentRequest,
  tags: readonly string[],
): Promise<string | null> {
  const digests: (string | null)[] = [];
  for (const tag of tags) {
    const digest = await pushImage({ tag, logStreamer: run.logStreamer, taskRunId: request.taskRunId });
    if (digest === null) {
      logDeploy(run, request, "warn", `Push of ${tag} failed`);
    }
    digests.push(digest);
  }
  return digests[0] ?? null;
}

async function recordBuiltImage(
  run: RunContext,
  registry: ParsedRegistry | null,
  details: { readonly digest: string | null; readonly sizeBytes: number | null },
): Promise<void> {
  const { job, variableContext } = run;
  try {
    await run.client.recordImage(job.run_id, {
      registry: registry?.host ?? LOCAL_REGISTRY,
      repository: registry?.namespace ? `${registry.namespace}/${job.project_slug}` : job.project_slug,
      tag: variableContext.git.short_sha,
      ...(details.digest ? { digest: details.digest } : {}),
      ...(details.sizeBytes !== null ? { size_bytes: details.sizeBytes } : {}),
    });
  } catch (err) {
    // The image exists either way — don't fail the deploy over bookkeeping
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to record built image: ${msg}`);
  }
}

// ── Path / registry helpers ────────────────────────────────────────

/**
 * Resolves Dockerfile and build context relative to the workspace,
 * rejecting anything that escapes it. Returns workspace-relative paths.
 */
export function resolveBuildPaths(
  workspacePath: string,
  dockerfilePath: string,
  buildContext: string,
): { readonly dockerfile: string; readonly context: string } | null {
  const toRelative = (p: string): string | null => {
    const rel = relative(workspacePath, resolve(workspacePath, p || "."));
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel || ".";
  };

  const dockerfile = toRelative(dockerfilePath || "Dockerfile");
  const context = toRelative(buildContext || ".");
  return dockerfile && context ? { dockerfile, context } : null;
}

interface ParsedRegistry {
  /** Full prefix used for tags, e.g. "ghcr.io/acme" */
  readonly prefix: string;
  /** Registry host, e.g. "ghcr.io" */
  readonly host: string;
  /** Path below the host, e.g. "acme" ("" when none) */
  readonly namespace: string;
}

export function parseRegistry(value: string | undefined): ParsedRegistry | null {
  const prefix = value?.trim().replace(/\/+$/, "");
  if (!prefix) return null;

  const [host, ...rest] = prefix.split("/");
  return { prefix, host, namespace: rest.join("/") };
}

function logDeploy(
  run: RunContext,
  request: DeploymentRequest,
  level: "info" | "warn" | "error",
  message: string,
): void {
  run.logStreamer.push({
    level,
    message: `[deploy:${request.taskName}] ${message}`,
    task_run_id: request.taskRunId,
  });
}
