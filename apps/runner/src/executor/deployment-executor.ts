import { ensurePublicTunnel, type PublicTunnel } from "../deployers/public-tunnel";
import { chooseDeployTarget, type DeployConfig } from "@deployx/shared";
import { applyRateLimit } from "../deployers/rate-limit";
import { proxyContainerName } from "../deployers/public-tunnel";
import { scanImage } from "./security-scan";
import { createDeployer } from "../deployers";
import type { RunContext } from "./task-executor";
import { resolveDeployImage } from "./image-builder";
import { syncDocumentsForDeployment } from "../documents/document-syncer";

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
  rawRequest: DeploymentRequest,
): Promise<boolean> {
  const { client, job, logStreamer } = run;
  const request = resolveBrokeredTarget(run, rawRequest);
  if (!request) return false;
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

  if (deployConfig.security_scan?.enabled && !(await passesSecurityScan(run, request, image.imageTag))) {
    return false;
  }

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

    if (result.success && deployConfig.driver === "docker_local") {
      await publishDocuments(run, deployment_id, taskName, taskRunId);
      await applyProxyRateLimit(run, request);
    }

    const tunnel =
      result.success && deployConfig.driver === "docker_local" && deployConfig.public_url !== false
        ? await openPublicUrl(run, deployment_id, taskName, taskRunId)
        : null;

    await updateDeploymentStatus(run, deployment_id, result.success, tunnel);

    logStreamer.push(
      result.success
        ? {
            level: "info",
            message: `[deploy:${taskName}] Deployment active at ${tunnel?.url ?? result.publicUrl ?? "unknown"}`,
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

/**
 * Cloud service brokerage: `driver: auto` becomes the first target in
 * broker.prefer this runner can use. External targets only support
 * blue_green, so the strategy follows. Null (logged) when none fits.
 */
function resolveBrokeredTarget(run: RunContext, request: DeploymentRequest): DeploymentRequest | null {
  const { deployConfig, taskName, taskRunId } = request;
  if (deployConfig.driver !== "auto") return request;

  const prefer = deployConfig.broker?.prefer ?? ["docker_local", "railway", "fly_io"];
  const decision = chooseDeployTarget(prefer, {
    dockerAvailable: run.dockerAvailable,
    secrets: run.projectSecrets,
  });
  for (const reason of decision.reasons) {
    run.logStreamer.push({ level: "info", message: `[broker:${taskName}] skipped ${reason}`, task_run_id: taskRunId });
  }
  if (!decision.target) {
    run.logStreamer.push({
      level: "error",
      message: `[broker:${taskName}] No usable deploy target among ${prefer.join(", ")}`,
      task_run_id: taskRunId,
    });
    return null;
  }

  const strategy = decision.target === "docker_local" ? deployConfig.strategy : "blue_green";
  run.logStreamer.push({
    level: "info",
    message: `[broker:${taskName}] Selected ${decision.target}${strategy !== deployConfig.strategy ? ` (strategy ${deployConfig.strategy} → blue_green)` : ""}`,
    task_run_id: taskRunId,
  });
  return { ...request, deployConfig: { ...deployConfig, driver: decision.target, strategy } };
}

/** Trivy gate: false (deployment blocked) on findings when fail_on_findings is set. */
async function passesSecurityScan(
  run: RunContext,
  request: DeploymentRequest,
  imageTag: string,
): Promise<boolean> {
  const { logStreamer } = run;
  const { taskName, taskRunId } = request;
  const scan = request.deployConfig.security_scan!;
  if (!run.dockerAvailable) {
    logStreamer.push({ level: "warn", message: `[scan:${taskName}] Skipped: Docker not available`, task_run_id: taskRunId });
    return true;
  }
  logStreamer.push({
    level: "info",
    message: `[scan:${taskName}] Scanning ${imageTag} with Trivy (${scan.severity.join(", ")})…`,
    task_run_id: taskRunId,
  });
  try {
    const summary = await scanImage(imageTag, scan);
    const counts = Object.entries(summary.counts).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
    const blocked = summary.total > 0 && scan.fail_on_findings;
    logStreamer.push({
      level: summary.total === 0 ? "info" : blocked ? "error" : "warn",
      message: `[scan:${taskName}] ${summary.total} finding(s) — ${counts}${summary.top.length ? `; e.g. ${summary.top.join("; ")}` : ""}${blocked ? ". Deployment blocked (fail_on_findings)." : ""}`,
      task_run_id: taskRunId,
    });
    return !blocked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStreamer.push({ level: "error", message: `[scan:${taskName}] Scan failed: ${msg}`, task_run_id: taskRunId });
    // A gate that can't run must not silently pass when it is meant to block
    return !scan.fail_on_findings;
  }
}

/** Apply (or clear) deploy.rate_limit on the project proxy. Never fails the deploy. */
async function applyProxyRateLimit(run: RunContext, request: DeploymentRequest): Promise<void> {
  const { taskName, taskRunId, deployConfig } = request;
  try {
    const outcome = await applyRateLimit(proxyContainerName(run.job.project_slug), deployConfig.rate_limit);
    if (outcome !== "unchanged") {
      run.logStreamer.push({
        level: "info",
        message: deployConfig.rate_limit
          ? `[deploy:${taskName}] Rate limit: ${deployConfig.rate_limit.requests_per_second} req/s per client (burst ${deployConfig.rate_limit.burst})`
          : `[deploy:${taskName}] Rate limit removed`,
        task_run_id: taskRunId,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    run.logStreamer.push({ level: "warn", message: `[deploy:${taskName}] Rate limit not applied: ${msg}`, task_run_id: taskRunId });
  }
}

/**
 * Serve the project's public documents under /files/ on this deployment.
 * Never fails the deploy; the background syncer retries every minute.
 */
async function publishDocuments(
  run: RunContext,
  deploymentId: string,
  taskName: string,
  taskRunId: string | undefined,
): Promise<void> {
  const { logStreamer } = run;
  try {
    const result = await syncDocumentsForDeployment(run.client, deploymentId, run.job.project_slug);
    if (result.total > 0 || result.removed > 0) {
      logStreamer.push({
        level: result.failed > 0 ? "warn" : "info",
        message: `[deploy:${taskName}] Documents: ${result.total} served under /files/ (${result.uploaded} uploaded, ${result.removed} removed${result.failed > 0 ? `, ${result.failed} failed: ${result.errors.join("; ")}` : ""})`,
        task_run_id: taskRunId,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStreamer.push({
      level: "warn",
      message: `[deploy:${taskName}] Documents not published yet: ${msg}`,
      task_run_id: taskRunId,
    });
  }
}

/**
 * Give a docker_local deployment a temporary public URL. Never fails the
 * deploy: without a tunnel the app is still served on localhost.
 */
async function openPublicUrl(
  run: RunContext,
  deploymentId: string,
  taskName: string,
  taskRunId: string | undefined,
): Promise<PublicTunnel | null> {
  const { logStreamer } = run;
  try {
    logStreamer.push({
      level: "info",
      message: `[deploy:${taskName}] Opening public URL (Cloudflare tunnel)…`,
      task_run_id: taskRunId,
    });
    const tunnel = await ensurePublicTunnel(run.job.project_slug, deploymentId);
    logStreamer.push({
      level: "info",
      message: `[deploy:${taskName}] Public URL ${tunnel.reused ? "(reused) " : ""}${tunnel.url} — expires ${tunnel.expiresAt}`,
      task_run_id: taskRunId,
    });
    return tunnel;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStreamer.push({
      level: "warn",
      message: `[deploy:${taskName}] No public URL: ${msg}. The app is still reachable on this machine.`,
      task_run_id: taskRunId,
    });
    return null;
  }
}

async function updateDeploymentStatus(
  run: RunContext,
  deploymentId: string,
  success: boolean,
  tunnel: PublicTunnel | null = null,
): Promise<void> {
  try {
    await run.client.updateDeployment(run.job.run_id, deploymentId, {
      status: success ? "active" : "failed",
      health_status: success ? "healthy" : "unhealthy",
      ...(tunnel
        ? { public_url: tunnel.url, public_url_expires_at: tunnel.expiresAt }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to update deployment status: ${msg}`);
  }
}
