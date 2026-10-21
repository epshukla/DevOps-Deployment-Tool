import { describe, it, expect } from "vitest";
import {
  ensurePublicTunnel,
  isExpired,
  parseTunnelUrl,
  reapExpiredTunnels,
  type TunnelDocker,
} from "../public-tunnel";

const NOW = new Date("2026-10-20T10:00:00Z");
const URL_LINE = "2026-10-20T10:00:03Z INF |  https://brave-otter-lamp.trycloudflare.com  |";

interface FakeContainer {
  labels: Record<string, string>;
  logs: string[];
  running: boolean;
}

function fakeDocker(initial: Record<string, FakeContainer> = {}, printUrl = true) {
  const containers = new Map(Object.entries(initial));
  const calls: string[] = [];
  const docker: TunnelDocker = {
    isRunning: async (name) => containers.get(name)?.running ?? false,
    labelsOf: async (name) => containers.get(name)?.labels ?? null,
    logs: async (name) => containers.get(name)?.logs ?? [],
    run: async ({ name, labels, command }) => {
      calls.push(`run ${name} ${command.join(" ")}`);
      containers.set(name, { labels, logs: printUrl ? ["starting", URL_LINE] : ["starting"], running: true });
    },
    remove: async (name) => {
      calls.push(`remove ${name}`);
      containers.delete(name);
    },
    listTunnels: async () =>
      [...containers.entries()].filter(([, c]) => c.labels["deployx.role"] === "tunnel").map(([n]) => n),
    sleep: async () => {},
  };
  return { docker, calls, containers };
}

describe("parseTunnelUrl", () => {
  it("finds the trycloudflare URL in cloudflared's banner", () => {
    expect(parseTunnelUrl(["noise", URL_LINE, "more"])).toBe("https://brave-otter-lamp.trycloudflare.com");
    expect(parseTunnelUrl(["no url here"])).toBeNull();
  });
});

describe("isExpired", () => {
  it("treats missing or past expiry as expired", () => {
    expect(isExpired(undefined, NOW)).toBe(true);
    expect(isExpired("2026-10-20T09:00:00Z", NOW)).toBe(true);
    expect(isExpired("2026-10-21T09:00:00Z", NOW)).toBe(false);
  });
});

describe("ensurePublicTunnel", () => {
  it("starts cloudflared pointed at the project's nginx proxy with a 24h expiry", async () => {
    const { docker, calls } = fakeDocker();

    const tunnel = await ensurePublicTunnel("shop", "dep-1", { now: NOW, docker });

    expect(tunnel).toEqual({
      url: "https://brave-otter-lamp.trycloudflare.com",
      expiresAt: "2026-10-21T10:00:00.000Z",
      reused: false,
    });
    expect(calls).toContain(
      "run deployx-tunnel-shop tunnel --no-autoupdate --protocol http2 --url http://deployx-proxy-shop:80",
    );
  });

  it("reuses a live, unexpired tunnel so redeploys keep the same link", async () => {
    const { docker, calls } = fakeDocker({
      "deployx-tunnel-shop": {
        labels: { "deployx.role": "tunnel", "deployx.expiresAt": "2026-10-20T20:00:00.000Z" },
        logs: [URL_LINE],
        running: true,
      },
    });

    const tunnel = await ensurePublicTunnel("shop", "dep-2", { now: NOW, docker });

    expect(tunnel.reused).toBe(true);
    expect(tunnel.expiresAt).toBe("2026-10-20T20:00:00.000Z");
    expect(calls.filter((c) => c.startsWith("run"))).toHaveLength(0);
  });

  it("replaces an expired tunnel with a fresh one", async () => {
    const { docker, calls } = fakeDocker({
      "deployx-tunnel-shop": {
        labels: { "deployx.role": "tunnel", "deployx.expiresAt": "2026-10-19T00:00:00.000Z" },
        logs: [URL_LINE],
        running: true,
      },
    });

    const tunnel = await ensurePublicTunnel("shop", "dep-3", { now: NOW, docker });

    expect(tunnel.reused).toBe(false);
    expect(calls[0]).toBe("remove deployx-tunnel-shop");
  });

  it("cleans up and throws when cloudflared never prints a URL", async () => {
    const { docker, containers } = fakeDocker({}, false);
    await expect(
      ensurePublicTunnel("shop", "dep-4", { now: NOW, docker, timeoutMs: 5 }),
    ).rejects.toThrow(/did not report a public URL/);
    expect(containers.has("deployx-tunnel-shop")).toBe(false);
  });
});

describe("reapExpiredTunnels", () => {
  it("removes only tunnels past their expiry", async () => {
    const { docker } = fakeDocker({
      "deployx-tunnel-old": { labels: { "deployx.role": "tunnel", "deployx.expiresAt": "2026-10-20T09:59:00Z" }, logs: [], running: true },
      "deployx-tunnel-new": { labels: { "deployx.role": "tunnel", "deployx.expiresAt": "2026-10-20T23:00:00Z" }, logs: [], running: true },
    });

    expect(await reapExpiredTunnels(NOW, docker)).toEqual(["deployx-tunnel-old"]);
  });
});
