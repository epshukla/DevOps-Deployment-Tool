import type { DeployerDriver, DeployContext, DeployResult } from "./deployer-interface";
import type { DeploymentStatus, HealthStatus } from "@deployx/shared";
import { RailwayApiClient } from "./clients";
import type { RailwayEnvironment } from "./clients";
import { waitForHealthy, checkHealth } from "./health-checker";

// ── Constants ───────────────────────────────────────────────────

const DEPLOY_POLL_INTERVAL_MS = 10_000;
const DEPLOY_TIMEOUT_MS = 300_000; // 5 minutes
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const HEALTH_CHECK_RETRIES = 5;
const HEALTH_CHECK_INTERVAL_MS = 3_000;
const HEALTH_CHECK_START_PERIOD_MS = 5_000;
const DEFAULT_ENVIRONMENT_NAME = "production";

// Railway DeploymentStatus values that will not change without a new action
// (https://docs.railway.com/integrations/api/manage-deployments)
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "SUCCESS",
  "FAILED",
  "CRASHED",
  "REMOVED",
  "SKIPPED",
]);

// Statuses where a deployment is still in progress and must be cancelled
// rather than stopped
const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
  "BUILDING",
  "DEPLOYING",
  "INITIALIZING",
  "QUEUED",
  "WAITING",
]);

// ── Railway Deployer ────────────────────────────────────────────

export class RailwayDeployer implements DeployerDriver {
  readonly name = "railway";

  // Cached state from last deploy (for getStatus/getLogs within same run)
  private cachedClient: RailwayApiClient | null = null;
  private cachedDeploymentId: string | null = null;
  private cachedServiceId: string | null = null;
  private cachedPublicUrl: string | null = null;

  // ── Deploy ──────────────────────────────────────────────────

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const { logStreamer, taskRunId } = ctx;

    try {
      const railwayClient = this.getApiClient(ctx);
      const projectId = this.getProjectId(ctx);
      this.cachedClient = railwayClient;

      logStreamer.push({
        level: "info",
        message: `[railway] Starting deployment: ${ctx.imageTag}`,
        task_run_id: taskRunId,
      });

      // Validate image looks registry-qualified
      this.validateImageTag(ctx.imageTag);

      const target = await this.prepareService(ctx, railwayClient, projectId);
      this.cachedServiceId = target.serviceId;

      // Trigger a deployment of the service instance in the target environment
      const deploymentId = await railwayClient.deployServiceInstance(
        target.serviceId,
        target.environmentId,
      );
      this.cachedDeploymentId = deploymentId;

      logStreamer.push({
        level: "info",
        message: `[railway] Deployment created: ${deploymentId}`,
        task_run_id: taskRunId,
      });

      // Poll for deployment status
      const finalDeployment = await this.waitForDeployment(
        railwayClient,
        deploymentId,
      );

      if (finalDeployment.status !== "SUCCESS") {
        return {
          success: false,
          error: `Railway deployment failed with status: ${finalDeployment.status}`,
        };
      }

      return this.verifyDeployment(ctx, finalDeployment.staticUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logStreamer.push({
        level: "error",
        message: `[railway] ${msg}`,
        task_run_id: taskRunId,
      });
      return { success: false, error: msg };
    }
  }

  // ── Rollback ────────────────────────────────────────────────

  async rollback(
    ctx: DeployContext,
    targetRevisionImageTag: string,
  ): Promise<DeployResult> {
    ctx.logStreamer.push({
      level: "info",
      message: `[railway] Rolling back to ${targetRevisionImageTag}`,
      task_run_id: ctx.taskRunId,
    });

    return this.deploy({
      ...ctx,
      imageTag: targetRevisionImageTag,
    });
  }

  // ── Stop ────────────────────────────────────────────────────

  async stop(ctx: DeployContext): Promise<void> {
    const deploymentId = this.cachedDeploymentId;
    if (!deploymentId) return;

    try {
      const railwayClient = this.cachedClient ?? this.getApiClient(ctx);
      const { status } = await railwayClient.getDeployment(deploymentId);

      // In-progress deployments are cancelled; live ones are stopped
      const inProgress = IN_PROGRESS_STATUSES.has(status);
      if (inProgress) {
        await railwayClient.cancelDeployment(deploymentId);
      } else {
        await railwayClient.stopDeployment(deploymentId);
      }

      ctx.logStreamer.push({
        level: "info",
        message: `[railway] Deployment ${deploymentId} ${inProgress ? "cancelled" : "stopped"}`,
        task_run_id: ctx.taskRunId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logStreamer.push({
        level: "warn",
        message: `[railway] Failed to stop deployment ${deploymentId}: ${msg}`,
        task_run_id: ctx.taskRunId,
      });
    }
  }

  // ── Status ──────────────────────────────────────────────────

  async getStatus(_projectSlug: string): Promise<DeploymentStatus> {
    if (!this.cachedClient || !this.cachedDeploymentId) {
      return "unknown" as DeploymentStatus;
    }

    try {
      const deployment = await this.cachedClient.getDeployment(
        this.cachedDeploymentId,
      );
      return mapRailwayStatus(deployment.status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[railway] Failed to get status of deployment ${this.cachedDeploymentId}: ${msg}`);
      return "unknown" as DeploymentStatus;
    }
  }

  // ── Health ──────────────────────────────────────────────────

  async getHealth(
    _projectSlug: string,
    healthPath: string,
    _port: number,
  ): Promise<HealthStatus> {
    if (!this.cachedPublicUrl) {
      return "unknown" as HealthStatus;
    }

    try {
      const result = await checkHealth(
        `${this.cachedPublicUrl}${healthPath}`,
        HEALTH_CHECK_TIMEOUT_MS,
      );
      return result.passed
        ? ("healthy" as HealthStatus)
        : ("unhealthy" as HealthStatus);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[railway] Health probe of ${this.cachedPublicUrl} failed: ${msg}`);
      return "unknown" as HealthStatus;
    }
  }

  // ── Logs ────────────────────────────────────────────────────

  async getLogs(
    _containerName: string,
    tailLines = 100,
  ): Promise<readonly string[]> {
    if (!this.cachedClient || !this.cachedDeploymentId) {
      return [];
    }

    try {
      const logs = await this.cachedClient.getDeploymentLogs(
        this.cachedDeploymentId,
        tailLines,
      );
      return logs.map((l) => `${l.timestamp} ${l.message}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[railway] Failed to fetch logs for deployment ${this.cachedDeploymentId}: ${msg}`);
      return [];
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * RAILWAY_API_TOKEN is an account/workspace token (Bearer auth);
   * RAILWAY_PROJECT_TOKEN is a project token (Project-Access-Token header).
   */
  private getApiClient(ctx: DeployContext): RailwayApiClient {
    const accountToken = ctx.secrets.RAILWAY_API_TOKEN;
    if (accountToken) {
      return new RailwayApiClient({ apiToken: accountToken, tokenType: "account" });
    }

    const projectToken = ctx.secrets.RAILWAY_PROJECT_TOKEN;
    if (projectToken) {
      return new RailwayApiClient({ apiToken: projectToken, tokenType: "project" });
    }

    throw new Error(
      "RAILWAY_API_TOKEN (or RAILWAY_PROJECT_TOKEN) secret required. Add it in Project Settings → Secrets.",
    );
  }

  private getProjectId(ctx: DeployContext): string {
    const projectId =
      ctx.secrets.RAILWAY_PROJECT_ID ?? ctx.config.railway?.project_id;
    if (!projectId) {
      throw new Error(
        "RAILWAY_PROJECT_ID required. Set it as a project secret or in deploy config railway.project_id.",
      );
    }
    return projectId;
  }

  /**
   * Picks the Railway environment: RAILWAY_ENVIRONMENT_ID secret if set,
   * otherwise the "production" environment, otherwise the only environment.
   */
  private resolveEnvironmentId(
    ctx: DeployContext,
    environments: readonly RailwayEnvironment[],
  ): string {
    const explicit = ctx.secrets.RAILWAY_ENVIRONMENT_ID;
    if (explicit) return explicit;

    const production = environments.find((e) => e.name === DEFAULT_ENVIRONMENT_NAME);
    if (production) return production.id;

    if (environments.length === 1) return environments[0].id;

    throw new Error(
      `Could not determine Railway environment (found ${environments.length}, none named "${DEFAULT_ENVIRONMENT_NAME}"). Set the RAILWAY_ENVIRONMENT_ID secret.`,
    );
  }

  private validateImageTag(imageTag: string): void {
    if (!imageTag.includes("/")) {
      throw new Error(
        `External deployers require a registry-qualified image (e.g., ghcr.io/user/app:tag), got: ${imageTag}`,
      );
    }
  }

  /**
   * Resolves the environment, finds or creates the service pointing at the
   * image, and applies env variables and region before a deploy is triggered.
   */
  private async prepareService(
    ctx: DeployContext,
    client: RailwayApiClient,
    projectId: string,
  ): Promise<{ readonly serviceId: string; readonly environmentId: string }> {
    const project = await client.getProject(projectId);
    const environmentId = this.resolveEnvironmentId(ctx, project.environments);

    // Find or create service
    const serviceName = `deployx-${ctx.projectSlug}`;
    const existing = project.services.find((s) => s.name === serviceName);
    const service = existing
      ?? (await client.createService(projectId, serviceName, ctx.imageTag));

    if (existing) {
      await client.connectServiceImage(existing.id, ctx.imageTag);
    }

    ctx.logStreamer.push({
      level: "info",
      message: `[railway] Using service: ${service.name} (${service.id})`,
      task_run_id: ctx.taskRunId,
    });

    const env = ctx.config.env ?? {};
    if (Object.keys(env).length > 0) {
      await client.upsertVariables(
        { projectId, environmentId, serviceId: service.id },
        env,
      );
    }

    const region = ctx.config.railway?.region;
    if (region) {
      await client.updateServiceInstance(service.id, environmentId, { region });
    }

    return { serviceId: service.id, environmentId };
  }

  /**
   * Health-checks the deployment's public URL (when Railway assigned one).
   */
  private async verifyDeployment(
    ctx: DeployContext,
    staticUrl: string | null | undefined,
  ): Promise<DeployResult> {
    const publicUrl = staticUrl ? `https://${staticUrl}` : undefined;
    this.cachedPublicUrl = publicUrl ?? null;

    ctx.logStreamer.push({
      level: "info",
      message: `[railway] Deployment live${publicUrl ? ` at ${publicUrl}` : ""}`,
      task_run_id: ctx.taskRunId,
    });

    if (!publicUrl) {
      return { success: true };
    }

    const healthPath = ctx.config.health_check?.path ?? "/health";
    const healthResult = await waitForHealthy({
      url: `${publicUrl}${healthPath}`,
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      retries: HEALTH_CHECK_RETRIES,
      intervalMs: HEALTH_CHECK_INTERVAL_MS,
      startPeriodMs: HEALTH_CHECK_START_PERIOD_MS,
    });

    await this.reportHealthCheck(ctx, healthResult);

    if (!healthResult.passed) {
      return {
        success: false,
        publicUrl,
        error: `Health check failed: ${healthResult.error}`,
      };
    }

    return { success: true, publicUrl };
  }

  private async waitForDeployment(
    client: RailwayApiClient,
    deploymentId: string,
  ): Promise<{ readonly status: string; readonly staticUrl?: string | null }> {
    const start = Date.now();

    while (Date.now() - start < DEPLOY_TIMEOUT_MS) {
      const deployment = await client.getDeployment(deploymentId);

      if (TERMINAL_STATUSES.has(deployment.status)) {
        return deployment;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, DEPLOY_POLL_INTERVAL_MS),
      );
    }

    return { status: "TIMEOUT" };
  }

  private async reportHealthCheck(
    ctx: DeployContext,
    result: {
      readonly passed: boolean;
      readonly statusCode: number | null;
      readonly responseTimeMs: number;
      readonly error?: string;
    },
  ): Promise<void> {
    try {
      await ctx.client.recordHealthCheck(ctx.job.run_id, ctx.deploymentId, {
        status: result.passed ? "pass" : "fail",
        response_time_ms: result.responseTimeMs,
        status_code: result.statusCode ?? undefined,
        error_message: result.error,
      });
    } catch (err) {
      // Don't fail the deployment over a reporting error
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[railway] Failed to report health check: ${msg}`);
    }
  }
}

// ── Status Mapping ──────────────────────────────────────────────

function mapRailwayStatus(status: string): DeploymentStatus {
  switch (status) {
    case "SUCCESS":
    case "SLEEPING":
      return "active";
    case "BUILDING":
    case "DEPLOYING":
    case "INITIALIZING":
      return "deploying";
    case "FAILED":
    case "CRASHED":
      return "failed";
    case "REMOVED":
    case "CANCELLED":
      return "stopped";
    default:
      return "pending";
  }
}
