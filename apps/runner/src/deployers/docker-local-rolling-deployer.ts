import { removePublicTunnel } from "./public-tunnel";
import { appRuntimeFromConfig, withRuntimeLabel } from "./app-runtime";
import {
  DEPLOYER_NETWORK_NAME,
  ROLLING_DEFAULT_INSTANCES,
  ROLLING_MAX_UNAVAILABLE,
  ROLLING_OBSERVATION_SECONDS,
  ROLLING_MAX_INSTANCES,
} from "@deployx/shared";
import type { DeploymentStatus, HealthStatus } from "@deployx/shared";
import type { DeployerDriver, DeployContext, DeployResult } from "./deployer-interface";
import {
  ensureNetwork,
  runContainer,
  stopContainer,
  removeContainerIfExists,
  isContainerRunning,
  inspectContainer,
  getContainerLogs,
  type ContainerInspection,
} from "./container-manager";
import { allocatePort, releasePort } from "./port-allocator";
import {
  generateWeightedNginxConfig,
  writeNginxConfig,
  reloadNginx,
} from "./nginx-config";
import { waitForHealthyViaDocker, checkHealthViaDocker } from "./health-checker";
import {
  resolvePreviousImage,
  withPreviousImageLabel,
  readPreviousImage,
} from "./previous-image";

// ── Types ───────────────────────────────────────────────────────

interface RunningInstance {
  readonly ordinal: number;
  readonly containerName: string;
  readonly inspection: ContainerInspection;
}

interface HealthSettings {
  readonly retries: number;
  readonly timeoutS: number;
  readonly intervalS: number;
  readonly startPeriodS: number;
}

interface RolloutPlan {
  readonly appPort: number;
  readonly healthPath: string;
  readonly health: HealthSettings;
  readonly deployEnv: Record<string, string>;
  readonly proxyContainerName: string;
  readonly instanceCount: number;
  /** Image being replaced — rollback target and previous-image label */
  readonly previousImage: string | null;
  /** Label the outgoing instances carried, restored if we roll back */
  readonly outgoingPreviousImageLabel: string | null;
}

// ── DockerLocalRollingDeployer ───────────────────────────────────

export class DockerLocalRollingDeployer implements DeployerDriver {
  readonly name = "docker_local";

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const { logStreamer, config, projectSlug } = ctx;
    const appPort = config.port;
    const healthPath = config.health_check?.path ?? "/health";
    const health: HealthSettings = {
      retries: config.health_check?.retries ?? 3,
      timeoutS: config.health_check?.timeout_seconds ?? 5,
      intervalS: config.health_check?.interval_seconds ?? 10,
      startPeriodS: config.health_check?.start_period_seconds ?? 15,
    };

    const instanceCount = config.rolling?.instances ?? ROLLING_DEFAULT_INSTANCES;
    const maxUnavailable = Math.min(
      config.rolling?.max_unavailable ?? ROLLING_MAX_UNAVAILABLE,
      instanceCount,
    );
    const observationSeconds = config.rolling?.observation_seconds ?? ROLLING_OBSERVATION_SECONDS;

    try {
      // 1. Ensure Docker network
      await ensureNetwork(DEPLOYER_NETWORK_NAME);

      // 2. Discover existing instances
      const existingInstances = await this.discoverInstances(projectSlug);

      // 3. First deploy — start all instances fresh
      if (existingInstances.length === 0) {
        return this.firstDeploy(ctx, instanceCount, appPort, healthPath, health);
      }

      logStreamer.push({
        level: "info",
        message: `[deploy:rolling] Rolling update: ${instanceCount} instances, maxUnavailable=${maxUnavailable}`,
        task_run_id: ctx.taskRunId,
      });

      const portAllocation = allocatePort(projectSlug);
      const proxyContainerName = this.getProxyContainerName(projectSlug);
      await this.ensureProxyContainer(proxyContainerName, portAllocation.proxyPort, projectSlug);

      const outgoing = existingInstances[0].inspection;
      const plan: RolloutPlan = {
        appPort,
        healthPath,
        health,
        deployEnv: { ...(config.env ?? {}), PORT: String(appPort) },
        proxyContainerName,
        instanceCount,
        previousImage: resolvePreviousImage(outgoing, ctx.imageTag),
        outgoingPreviousImageLabel: readPreviousImage(outgoing),
      };

      // 4. Rolling update — replace instances respecting maxUnavailable
      const updatedOrdinals: number[] = [];
      for (let i = 0; i < instanceCount; i += maxUnavailable) {
        const batch = Array.from(
          { length: Math.min(maxUnavailable, instanceCount - i) },
          (_, j) => i + j,
        );

        const failure = await this.replaceBatch(ctx, plan, batch, updatedOrdinals);
        if (failure) return failure;

        // Observation period
        if (i + maxUnavailable < instanceCount) {
          logStreamer.push({
            level: "info",
            message: `[deploy:rolling] Observing for ${observationSeconds}s before next batch`,
            task_run_id: ctx.taskRunId,
          });
          await sleep(observationSeconds * 1000);
        }
      }

      const publicUrl = `http://localhost:${portAllocation.proxyPort}`;
      logStreamer.push({
        level: "info",
        message: `[deploy:rolling] All ${instanceCount} instances updated. Active at ${publicUrl}`,
        task_run_id: ctx.taskRunId,
      });

      return { success: true, publicUrl, hostPort: portAllocation.proxyPort };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logStreamer.push({
        level: "error",
        message: `[deploy:rolling] Deployment failed: ${message}`,
        task_run_id: ctx.taskRunId,
      });
      return { success: false, error: message };
    }
  }

  async rollback(
    ctx: DeployContext,
    targetRevisionImageTag: string,
  ): Promise<DeployResult> {
    ctx.logStreamer.push({
      level: "info",
      message: `[deploy:rolling] Rolling back all instances to: ${targetRevisionImageTag}`,
      task_run_id: ctx.taskRunId,
    });

    return this.deploy({ ...ctx, imageTag: targetRevisionImageTag });
  }

  async stop(ctx: DeployContext): Promise<void> {
    const { projectSlug } = ctx;
    await removePublicTunnel(projectSlug);
    const instanceCount = ctx.config.rolling?.instances ?? ROLLING_DEFAULT_INSTANCES;

    for (let i = 0; i < instanceCount; i++) {
      await removeContainerIfExists(this.getInstanceContainerName(projectSlug, i));
    }
    await removeContainerIfExists(this.getProxyContainerName(projectSlug));
    releasePort(projectSlug);
  }

  async getStatus(projectSlug: string): Promise<DeploymentStatus> {
    // Check if any instance is running
    for (let i = 0; i < ROLLING_MAX_INSTANCES; i++) {
      const name = this.getInstanceContainerName(projectSlug, i);
      if (await isContainerRunning(name)) return "active";
    }
    return "stopped";
  }

  async getHealth(
    projectSlug: string,
    healthPath: string,
    port: number,
  ): Promise<HealthStatus> {
    // Probe all discoverable instances, healthy if majority pass
    let total = 0;
    let healthy = 0;

    for (let i = 0; i < ROLLING_MAX_INSTANCES; i++) {
      const name = this.getInstanceContainerName(projectSlug, i);
      if (!(await isContainerRunning(name))) continue;
      total++;

      const result = await checkHealthViaDocker(name, port, healthPath, 5000);
      if (result.passed) healthy++;
    }

    if (total === 0) return "unknown";
    if (healthy === total) return "healthy";
    if (healthy > total / 2) return "degraded";
    return "unhealthy";
  }

  async getLogs(
    containerName: string,
    tailLines = 100,
  ): Promise<readonly string[]> {
    return getContainerLogs(containerName, tailLines);
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Replaces one batch of instances: drain them from nginx, stop the old
   * containers, start + health-check the new ones, then reload nginx so it
   * re-resolves the recreated containers' new IPs. Returns a failed
   * DeployResult (after rolling back) or null on success.
   */
  private async replaceBatch(
    ctx: DeployContext,
    plan: RolloutPlan,
    batch: readonly number[],
    updatedOrdinals: number[],
  ): Promise<DeployResult | null> {
    const { projectSlug } = ctx;

    // Take the batch out of rotation before stopping it
    await this.updateNginxForRunningInstances(ctx, plan, batch);

    for (const ordinal of batch) {
      const containerName = this.getInstanceContainerName(projectSlug, ordinal);
      if (await isContainerRunning(containerName)) {
        await stopContainer(containerName, 10);
        await removeContainerIfExists(containerName);
      }
    }

    for (const ordinal of batch) {
      const failure = await this.startAndVerifyInstance(ctx, plan, ordinal, updatedOrdinals);
      if (failure) return failure;
      updatedOrdinals.push(ordinal);

      await this.recordHealingEvent(ctx, "rolling_instance_updated", {
        ordinal,
        image_tag: ctx.imageTag,
        instances_updated: updatedOrdinals.length,
        instances_total: plan.instanceCount,
      });
    }

    // New instances are healthy — reload so nginx resolves their new IPs
    await this.updateNginxForRunningInstances(ctx, plan);
    return null;
  }

  private async startAndVerifyInstance(
    ctx: DeployContext,
    plan: RolloutPlan,
    ordinal: number,
    updatedOrdinals: readonly number[],
  ): Promise<DeployResult | null> {
    const { logStreamer } = ctx;
    const containerName = this.getInstanceContainerName(ctx.projectSlug, ordinal);

    logStreamer.push({
      level: "info",
      message: `[deploy:rolling] Updating instance ${ordinal} with ${ctx.imageTag}`,
      task_run_id: ctx.taskRunId,
    });

    await runContainer({
      name: containerName,
      image: ctx.imageTag,
      network: DEPLOYER_NETWORK_NAME,
      env: plan.deployEnv,
      ...appRuntimeFromConfig(ctx.config, ctx.projectSlug),
      labels: withPreviousImageLabel(
        this.buildLabels(ctx, ordinal, plan.appPort, plan.healthPath),
        plan.previousImage,
      ),
      detach: true,
      restart: "unless-stopped",
    });

    // Health check new instance (via docker exec — host can't resolve container names)
    const healthResult = await this.waitForInstance(containerName, plan);
    await this.reportHealthCheck(ctx, healthResult.passed, {
      statusCode: healthResult.statusCode,
      responseTimeMs: healthResult.responseTimeMs,
      error: healthResult.error,
    });

    if (healthResult.passed) return null;

    logStreamer.push({
      level: "error",
      message: `[deploy:rolling] Instance ${ordinal} unhealthy. Rolling back.`,
      task_run_id: ctx.taskRunId,
    });

    const rolledBack = [...updatedOrdinals, ordinal];
    await this.rollbackInstances(ctx, plan, rolledBack);
    await this.updateNginxForRunningInstances(ctx, plan);

    await this.recordHealingEvent(ctx, "rolling_rollback", {
      failed_ordinal: ordinal,
      rolled_back_ordinals: rolledBack,
      error: healthResult.error,
    });

    return {
      success: false,
      error: `Instance ${ordinal} unhealthy: ${healthResult.error}`,
    };
  }

  private waitForInstance(containerName: string, plan: RolloutPlan) {
    return waitForHealthyViaDocker({
      containerName,
      port: plan.appPort,
      path: plan.healthPath,
      timeoutMs: plan.health.timeoutS * 1000,
      retries: plan.health.retries,
      intervalMs: plan.health.intervalS * 1000,
      startPeriodMs: plan.health.startPeriodS * 1000,
    });
  }

  private async firstDeploy(
    ctx: DeployContext,
    instanceCount: number,
    appPort: number,
    healthPath: string,
    healthConfig: HealthSettings,
  ): Promise<DeployResult> {
    const { logStreamer, config, projectSlug } = ctx;

    logStreamer.push({
      level: "info",
      message: `[deploy:rolling] First deploy — starting ${instanceCount} instances from ${ctx.imageTag}`,
      task_run_id: ctx.taskRunId,
    });

    const deployEnv: Record<string, string> = {
      ...(config.env ?? {}),
      PORT: String(appPort),
    };

    for (let i = 0; i < instanceCount; i++) {
      const containerName = this.getInstanceContainerName(projectSlug, i);
      await removeContainerIfExists(containerName);

      await runContainer({
        name: containerName,
        image: ctx.imageTag,
        network: DEPLOYER_NETWORK_NAME,
        env: deployEnv,
        ...appRuntimeFromConfig(ctx.config, ctx.projectSlug),
        labels: this.buildLabels(ctx, i, appPort, healthPath),
        detach: true,
        restart: "unless-stopped",
      });

      const healthResult = await waitForHealthyViaDocker({
        containerName,
        port: appPort,
        path: healthPath,
        timeoutMs: healthConfig.timeoutS * 1000,
        retries: healthConfig.retries,
        intervalMs: healthConfig.intervalS * 1000,
        startPeriodMs: healthConfig.startPeriodS * 1000,
      });

      await this.reportHealthCheck(ctx, healthResult.passed, {
        statusCode: healthResult.statusCode,
        responseTimeMs: healthResult.responseTimeMs,
        error: healthResult.error,
      });

      if (!healthResult.passed) {
        // Clean up any started instances
        for (let j = 0; j <= i; j++) {
          await removeContainerIfExists(
            this.getInstanceContainerName(projectSlug, j),
          );
        }
        return { success: false, error: `Instance ${i} health check failed: ${healthResult.error}` };
      }
    }

    // Configure nginx with all instances
    const portAllocation = allocatePort(projectSlug);
    const proxyContainerName = this.getProxyContainerName(projectSlug);
    await this.ensureProxyContainer(proxyContainerName, portAllocation.proxyPort, projectSlug);

    await this.writeAndReloadNginx(
      proxyContainerName,
      Array.from({ length: instanceCount }, (_, i) => this.getInstanceContainerName(projectSlug, i)),
      appPort,
      healthPath,
    );

    const publicUrl = `http://localhost:${portAllocation.proxyPort}`;
    return { success: true, publicUrl, hostPort: portAllocation.proxyPort };
  }

  private async discoverInstances(
    projectSlug: string,
  ): Promise<readonly RunningInstance[]> {
    const instances: RunningInstance[] = [];

    for (let i = 0; i < ROLLING_MAX_INSTANCES; i++) {
      const name = this.getInstanceContainerName(projectSlug, i);
      const inspection = await inspectContainer(name);
      if (inspection?.state === "running") {
        instances.push({ ordinal: i, containerName: name, inspection });
      }
    }

    return instances;
  }

  private async rollbackInstances(
    ctx: DeployContext,
    plan: RolloutPlan,
    ordinals: readonly number[],
  ): Promise<void> {
    if (!plan.previousImage) {
      ctx.logStreamer.push({
        level: "warn",
        message: `[deploy:rolling] No previous image recorded — cannot roll back instance(s) ${ordinals.join(", ")}`,
        task_run_id: ctx.taskRunId,
      });
      return;
    }

    ctx.logStreamer.push({
      level: "info",
      message: `[deploy:rolling] Rolling back instance(s) ${ordinals.join(", ")} to ${plan.previousImage}`,
      task_run_id: ctx.taskRunId,
    });

    for (const ordinal of ordinals) {
      const containerName = this.getInstanceContainerName(ctx.projectSlug, ordinal);
      await removeContainerIfExists(containerName);

      await runContainer({
        name: containerName,
        image: plan.previousImage,
        network: DEPLOYER_NETWORK_NAME,
        env: plan.deployEnv,
        ...appRuntimeFromConfig(ctx.config, ctx.projectSlug),
        labels: withPreviousImageLabel(
          this.buildLabels(ctx, ordinal, plan.appPort, plan.healthPath),
          plan.outgoingPreviousImageLabel,
        ),
        detach: true,
        restart: "unless-stopped",
      });
    }
  }

  /**
   * Points nginx at every instance that currently exists, minus `exclude`.
   * nginx fails its config test on unresolvable upstream names, so instances
   * that don't exist (yet) are left out. Skips the reload when nothing would
   * remain (e.g. maxUnavailable == instances) rather than writing an empty
   * upstream block.
   */
  private async updateNginxForRunningInstances(
    ctx: DeployContext,
    plan: RolloutPlan,
    exclude: readonly number[] = [],
  ): Promise<void> {
    const names: string[] = [];
    for (let i = 0; i < Math.max(plan.instanceCount, ROLLING_MAX_INSTANCES); i++) {
      if (exclude.includes(i)) continue;
      const name = this.getInstanceContainerName(ctx.projectSlug, i);
      if (await isContainerRunning(name)) names.push(name);
    }

    if (names.length === 0) return;
    await this.writeAndReloadNginx(plan.proxyContainerName, names, plan.appPort, plan.healthPath);
  }

  private async writeAndReloadNginx(
    proxyContainerName: string,
    upstreamNames: readonly string[],
    appPort: number,
    healthCheckPath: string,
  ): Promise<void> {
    const nginxConfig = generateWeightedNginxConfig({
      listenPort: 80,
      upstreams: upstreamNames.map((name) => ({ name, port: appPort })),
      healthCheckPath,
    });

    await writeNginxConfig(proxyContainerName, nginxConfig);
    await reloadNginx(proxyContainerName);
  }

  private buildLabels(
    ctx: DeployContext,
    ordinal: number,
    appPort: number,
    healthPath: string,
  ): Record<string, string> {
    return withRuntimeLabel({
      "deployx.project": ctx.projectSlug,
      "deployx.role": "app",
      "deployx.strategy": "rolling",
      "deployx.ordinal": String(ordinal),
      "deployx.deployment": ctx.deploymentId,
      "deployx.runId": ctx.job.run_id,
      "deployx.healthPath": healthPath,
      "deployx.appPort": String(appPort),
    }, appRuntimeFromConfig(ctx.config, ctx.projectSlug));
  }

  private getInstanceContainerName(projectSlug: string, ordinal: number): string {
    return `deployx-${projectSlug}-inst-${ordinal}`;
  }

  private getProxyContainerName(projectSlug: string): string {
    return `deployx-proxy-${projectSlug}`;
  }

  private async ensureProxyContainer(
    proxyContainerName: string,
    hostPort: number,
    projectSlug: string,
  ): Promise<void> {
    if (await isContainerRunning(proxyContainerName)) return;
    await removeContainerIfExists(proxyContainerName);

    await runContainer({
      name: proxyContainerName,
      image: "nginx:alpine",
      network: DEPLOYER_NETWORK_NAME,
      ports: [{ host: hostPort, container: 80 }],
      labels: {
        "deployx.project": projectSlug,
        "deployx.role": "proxy",
      },
      detach: true,
      restart: "unless-stopped",
    });

    await sleep(2000);
  }

  private async reportHealthCheck(
    ctx: DeployContext,
    passed: boolean,
    details: {
      statusCode: number | null;
      responseTimeMs: number;
      error?: string;
    },
  ): Promise<void> {
    try {
      await ctx.client.recordHealthCheck(ctx.job.run_id, ctx.deploymentId, {
        status: passed ? "pass" : "fail",
        status_code: details.statusCode ?? undefined,
        response_time_ms: details.responseTimeMs,
        error_message: details.error,
      });
    } catch (err) {
      // Fire-and-forget — don't fail the rollout over an API error
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[deploy:rolling] Failed to report health check: ${msg}`);
    }
  }

  private async recordHealingEvent(
    ctx: DeployContext,
    eventType: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await ctx.client.recordHealingEvent(ctx.job.run_id, ctx.deploymentId, {
        event_type: eventType,
        details,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[deploy:rolling] Failed to record ${eventType} event: ${msg}`);
    }
  }
}

// ── Utility ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
