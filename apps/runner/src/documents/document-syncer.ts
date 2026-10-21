import { DOCUMENT_SYNC_INTERVAL_MS } from "@deployx/shared";
import type { RunnerApiClient } from "../api-client";
import {
  inspectContainer,
  isContainerRunning,
  listContainersByLabel,
} from "../deployers/container-manager";
import { readNginxSnippet, writeNginxSnippet } from "../deployers/nginx-config";
import { proxyContainerName } from "../deployers/public-tunnel";
import { ObjectStore } from "./object-store";
import { syncProjectDocuments, type ProxyOps, type SyncResult } from "./document-sync";

const defaultProxyOps: ProxyOps = {
  isRunning: isContainerRunning,
  readSnippet: readNginxSnippet,
  writeSnippet: writeNginxSnippet,
};

/** Sync one deployment's project documents now (used right after a deploy). */
export async function syncDocumentsForDeployment(
  client: RunnerApiClient,
  deploymentId: string,
  projectSlug: string,
  store: ObjectStore = new ObjectStore(),
): Promise<SyncResult> {
  const manifest = await client.getDocumentManifest(deploymentId);
  return syncProjectDocuments(manifest, proxyContainerName(projectSlug), {
    store,
    proxy: defaultProxyOps,
  });
}

/**
 * One deployment id per project with a docker_local app container on this
 * machine. Any of a project's deployments works: the manifest is per project.
 */
export async function discoverLocalProjects(): Promise<ReadonlyMap<string, string>> {
  const projects = new Map<string, string>();
  for (const container of await listContainersByLabel("deployx.role=app")) {
    const labels = (await inspectContainer(container.name))?.labels ?? {};
    const slug = labels["deployx.project"];
    const deploymentId = labels["deployx.deployment"];
    if (slug && deploymentId && !projects.has(slug)) projects.set(slug, deploymentId);
  }
  return projects;
}

/**
 * Background loop: every DOCUMENT_SYNC_INTERVAL_MS, mirror each locally
 * hosted project's public documents, so uploads, deletions and visibility
 * changes in the dashboard reach the public URL without a redeploy.
 */
export class DocumentSyncer {
  private readonly client: RunnerApiClient;
  private readonly intervalMs: number;
  private readonly store = new ObjectStore();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: { readonly client: RunnerApiClient; readonly intervalMs?: number }) {
    this.client = options.client;
    this.intervalMs = options.intervalMs ?? DOCUMENT_SYNC_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const [slug, deploymentId] of await discoverLocalProjects()) {
        try {
          const result = await syncDocumentsForDeployment(this.client, deploymentId, slug, this.store);
          if (result.uploaded > 0 || result.removed > 0) {
            console.log(
              `[documents] ${slug}: ${result.uploaded} uploaded, ${result.removed} removed (${result.total} served)`,
            );
          }
          for (const error of result.errors) console.error(`[documents] ${slug}: ${error}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // 404: the deployment was deleted; nothing to do for it
          if (!msg.includes("404")) console.error(`[documents] ${slug}: sync failed: ${msg}`);
        }
      }
    } catch (err) {
      console.error(`[documents] discovery failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}
