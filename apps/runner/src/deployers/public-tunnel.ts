import {
  CLOUDFLARED_IMAGE,
  DEPLOYER_NETWORK_NAME,
  PUBLIC_URL_STARTUP_TIMEOUT_MS,
  PUBLIC_URL_TTL_HOURS,
} from "@deployx/shared";
import {
  getContainerLogs,
  inspectContainer,
  isContainerRunning,
  listContainersByLabel,
  removeContainerIfExists,
  runContainer,
} from "./container-manager";

/**
 * Temporary public URLs for docker_local deployments.
 *
 * A Cloudflare *quick tunnel* (`cloudflared tunnel --url …`) needs no account
 * or domain: it prints a random https://<words>.trycloudflare.com address and
 * forwards it to the project's nginx proxy on the deployx network, so
 * blue-green / canary / rolling switching keeps working behind the URL.
 * The tunnel container carries an expiry label and is removed after
 * PUBLIC_URL_TTL_HOURS. The URL only works while this machine and Docker are up.
 */

export interface PublicTunnel {
  readonly url: string;
  readonly expiresAt: string;
  readonly reused: boolean;
}

/** Docker operations, injectable for tests. */
export interface TunnelDocker {
  readonly isRunning: (name: string) => Promise<boolean>;
  readonly labelsOf: (name: string) => Promise<Readonly<Record<string, string>> | null>;
  readonly logs: (name: string) => Promise<readonly string[]>;
  readonly run: (options: {
    name: string;
    labels: Record<string, string>;
    command: readonly string[];
  }) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
  readonly listTunnels: () => Promise<readonly string[]>;
  readonly sleep: (ms: number) => Promise<void>;
}

const EXPIRES_LABEL = "deployx.expiresAt";
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const LOG_POLL_INTERVAL_MS = 1_000;

export function tunnelContainerName(projectSlug: string): string {
  return `deployx-tunnel-${projectSlug}`;
}

export function proxyContainerName(projectSlug: string): string {
  return `deployx-proxy-${projectSlug}`;
}

/** The last trycloudflare URL cloudflared printed, if any. */
export function parseTunnelUrl(logLines: readonly string[]): string | null {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const match = logLines[i].match(TUNNEL_URL_PATTERN);
    if (match) return match[0];
  }
  return null;
}

export function isExpired(expiresAt: string | undefined, now: Date): boolean {
  if (!expiresAt) return true;
  const time = Date.parse(expiresAt);
  return Number.isNaN(time) || time <= now.getTime();
}

const defaultDocker: TunnelDocker = {
  isRunning: isContainerRunning,
  labelsOf: async (name) => (await inspectContainer(name))?.labels ?? null,
  logs: (name) => getContainerLogs(name, 200),
  run: async ({ name, labels, command }) => {
    await runContainer({
      name,
      image: CLOUDFLARED_IMAGE,
      network: DEPLOYER_NETWORK_NAME,
      labels,
      command,
      detach: true,
      // A restarted quick tunnel gets a NEW random URL, so never auto-restart:
      // the next deploy creates a fresh one instead.
      restart: "no",
    });
  },
  remove: removeContainerIfExists,
  listTunnels: async () =>
    (await listContainersByLabel("deployx.role=tunnel")).map((c) => c.name),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function waitForUrl(
  docker: TunnelDocker,
  name: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = parseTunnelUrl(await docker.logs(name));
    if (url) return url;
    if (!(await docker.isRunning(name))) return null;
    await docker.sleep(LOG_POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Make sure the project has a live public tunnel. An unexpired tunnel from an
 * earlier deploy is reused (same URL, same expiry), so redeploying doesn't
 * hand out a new link every time. Throws if no URL appears in time.
 */
export async function ensurePublicTunnel(
  projectSlug: string,
  deploymentId: string,
  options: {
    readonly now?: Date;
    readonly ttlHours?: number;
    readonly timeoutMs?: number;
    readonly docker?: TunnelDocker;
  } = {},
): Promise<PublicTunnel> {
  const docker = options.docker ?? defaultDocker;
  const now = options.now ?? new Date();
  const name = tunnelContainerName(projectSlug);

  if (await docker.isRunning(name)) {
    const labels = await docker.labelsOf(name);
    const expiresAt = labels?.[EXPIRES_LABEL];
    const url = parseTunnelUrl(await docker.logs(name));
    if (url && expiresAt && !isExpired(expiresAt, now)) {
      return { url, expiresAt, reused: true };
    }
  }

  await docker.remove(name);

  const expiresAt = new Date(
    now.getTime() + (options.ttlHours ?? PUBLIC_URL_TTL_HOURS) * 3_600_000,
  ).toISOString();

  await docker.run({
    name,
    labels: {
      "deployx.project": projectSlug,
      "deployx.role": "tunnel",
      "deployx.deployment": deploymentId,
      [EXPIRES_LABEL]: expiresAt,
    },
    command: [
      "tunnel",
      "--no-autoupdate",
      // QUIC (UDP 7844) is blocked on many campus/office networks and the
      // tunnel then never connects (Cloudflare error 1033); HTTP/2 rides on
      // TCP 443, which works wherever HTTPS does
      "--protocol",
      "http2",
      "--url",
      `http://${proxyContainerName(projectSlug)}:80`,
    ],
  });

  const url = await waitForUrl(docker, name, options.timeoutMs ?? PUBLIC_URL_STARTUP_TIMEOUT_MS);
  if (!url) {
    await docker.remove(name);
    throw new Error("cloudflared did not report a public URL in time");
  }
  return { url, expiresAt, reused: false };
}

export async function removePublicTunnel(
  projectSlug: string,
  docker: TunnelDocker = defaultDocker,
): Promise<void> {
  await docker.remove(tunnelContainerName(projectSlug));
}

/** Remove every tunnel whose expiry has passed. Returns the removed names. */
export async function reapExpiredTunnels(
  now: Date = new Date(),
  docker: TunnelDocker = defaultDocker,
): Promise<readonly string[]> {
  const removed: string[] = [];
  for (const name of await docker.listTunnels()) {
    const labels = await docker.labelsOf(name);
    if (isExpired(labels?.[EXPIRES_LABEL], now)) {
      await docker.remove(name);
      removed.push(name);
    }
  }
  return removed;
}
