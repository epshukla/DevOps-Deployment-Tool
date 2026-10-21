import type { RateLimitConfig } from "@deployx/shared";
import {
  NGINX_HTTP_DIR,
  readNginxSnippet,
  removeNginxSnippet,
  writeNginxSnippet,
} from "./nginx-config";

/**
 * Control-layer QoS: a per-client token bucket at the project's nginx proxy
 * (limit_req). Requests over `requests_per_second` (+ `burst`) get 429.
 *
 * Behind the Cloudflare tunnel every request arrives from the cloudflared
 * container, so the client is keyed by the CF-Connecting-IP header Cloudflare
 * sets, falling back to the socket address for direct (localhost) traffic.
 * http-level so it covers the whole proxy, including /files/.
 */
export const RATE_LIMIT_FILE = "zz-deployx-ratelimit";

export function rateLimitConf(config: RateLimitConfig): string {
  return `map $http_cf_connecting_ip $deployx_client {
    ""      $binary_remote_addr;
    default $http_cf_connecting_ip;
}

limit_req_zone $deployx_client zone=deployx_rl:10m rate=${config.requests_per_second}r/s;
limit_req zone=deployx_rl burst=${config.burst} nodelay;
limit_req_status 429;
`;
}

/** Install, update or remove the limit on a proxy to match the config. */
export async function applyRateLimit(
  proxyContainerName: string,
  config: RateLimitConfig | undefined,
): Promise<"applied" | "removed" | "unchanged"> {
  if (!config) {
    const existing = await readNginxSnippet(proxyContainerName, RATE_LIMIT_FILE, NGINX_HTTP_DIR);
    if (existing === null) return "unchanged";
    await removeNginxSnippet(proxyContainerName, RATE_LIMIT_FILE, NGINX_HTTP_DIR);
    return "removed";
  }
  const conf = rateLimitConf(config);
  if ((await readNginxSnippet(proxyContainerName, RATE_LIMIT_FILE, NGINX_HTTP_DIR)) === conf) {
    return "unchanged";
  }
  await writeNginxSnippet(proxyContainerName, RATE_LIMIT_FILE, conf, NGINX_HTTP_DIR);
  return "applied";
}
