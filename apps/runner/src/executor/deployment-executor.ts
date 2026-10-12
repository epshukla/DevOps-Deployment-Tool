import type { DeployConfig } from "@deployx/shared";
import { createDeployer } from "../deployers";
import type { RunContext } from "./task-executor";
import { resolveDeployImage } from "./image-builder";

export interface DeploymentRequest {
  readonly taskName: string;
  readonly deployConfig: DeployConfig;
  readonly taskRunId: string | undefined;
}

/**
 * Executes a deployment after task steps succeed: resolves (or builds) the
 * image, creates the deployment record, invokes the deployer driver and
 * reports the result. Returns true on success; never throws.
 */
export async function executeDeployment(
  run: RunContext,
  request: DeploymentRequest,
): Promise<boolean> {
  const { client, job, logStreamer } = run;
  const { taskName, deployConfig, taskRunId } = request;

  // Docker is only required for docker_local deployments
  if (deployConfig.driver === "docker_local" && !run.dockerAvailable) {
    logStreamer.push({
      level: "error",
      message: `[deploy:${taskName}] Docker not available on this runner`,
      task_run_id: taskRunId,
    });
    return false;
  }

  // Explicit config image, or one built from the job's Dockerfile
  const image = await resolveDeployImage(run, request);
  if (!image) return false;

  logStreamer.push({
    level: "info",
    message: `[deploy:${taskName}] Starting deployment: ${image.imageTag} via ${deployConfig.driver}`,
    task_run_id: taskRunId,
  });

  try {
    // Create deployment record in control plane
    const { deployment_id, revision_id } = await client.createDeployment(job.run_id, {
      strategy: deployConfig.strategy,
      deploy_target: deployConfig.driver,
      image_tag: image.imageTag,
      ...(image.digest ? { image_digest: image.digest } : {}),
    });

    // Create the deployer driver
    const deployer = createDeployer(
      deployConfig.driver as Parameters<typeof createDeployer>[0],
      deployConfig.strategy as Parameters<typeof createDeployer>[1],
    );

    const result = await deployer.deploy({
      client,
      logStreamer,
      job,
      deploymentId: deployment_id,
      revisionId: revision_id,
      imageTag: image.imageTag,
      config: deployConfig,
      projectSlug: job.project_slug,
      taskRunId,
      secrets: run.projectSecrets,
    });

    await updateDeploymentStatus(run, deployment_id, result.success);

    logStreamer.push(
      result.success
        ? {
            level: "info",
            message: `[deploy:${taskName}] Deployment active at ${result.publicUrl ?? "unknown"}`,
            task_run_id: taskRunId,
          }
        : {
            level: "error",
            message: `[deploy:${taskName}] Deployment failed: ${result.error}`,
            task_run_id: taskRunId,
          },
    );

    return result.success;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStreamer.push({
      level: "error",
      message: `[deploy:${taskName}] Unexpected error: ${msg}`,
      task_run_id: taskRunId,
    });
    return false;
  }
}

async function updateDeploymentStatus(
  run: RunContext,
  deploymentId: string,
  success: boolean,
): Promise<void> {
  try {
    await run.client.updateDeployment(run.job.run_id, deploymentId, {
      status: success ? "active" : "failed",
      health_status: success ? "healthy" : "unhealthy",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to update deployment status: ${msg}`);
  }
}
