import { execa } from "execa";

// ── Types ───────────────────────────────────────────────────────

/**
 * Extra `server`-level snippets (documents, caching…) live here, one file per
 * feature, so they survive the deployers rewriting default.conf on every
 * cutover. A wildcard include that matches nothing is not an error.
 */
export const NGINX_SNIPPETS_DIR = "/etc/nginx/deployx.d";
/** http-level files (zones, maps): nginx.conf includes conf.d/*.conf in http {} */
export const NGINX_HTTP_DIR = "/etc/nginx/conf.d";

export interface NginxUpstream {
  readonly name: string;
  readonly port: number;
}

export interface WeightedUpstreamServer {
  readonly name: string;
  readonly port: number;
  readonly weight?: number;
}

// ── Config Generation ───────────────────────────────────────────

export function generateNginxConfig(options: {
  readonly listenPort: number;
  readonly upstream: NginxUpstream;
  readonly healthCheckPath: string;
}): string {
  const { listenPort, upstream, healthCheckPath } = options;

  return `
upstream app {
    server ${upstream.name}:${upstream.port};
}

server {
    listen ${listenPort};

    location / {
        proxy_pass http://app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }

    location ${healthCheckPath} {
        proxy_pass http://app${healthCheckPath};
        proxy_connect_timeout 3s;
        proxy_read_timeout 5s;
    }

    include ${NGINX_SNIPPETS_DIR}/*.conf;
}
`.trimStart();
}

// ── Weighted Config Generation ──────────────────────────────────

export function generateWeightedNginxConfig(options: {
  readonly listenPort: number;
  readonly upstreams: readonly WeightedUpstreamServer[];
  readonly healthCheckPath: string;
}): string {
  const { listenPort, upstreams, healthCheckPath } = options;

  const serverLines = upstreams
    .map((u) => {
      const weightPart = u.weight != null && u.weight !== 1 ? ` weight=${u.weight}` : "";
      return `    server ${u.name}:${u.port}${weightPart};`;
    })
    .join("\n");

  return `upstream app {
${serverLines}
}

server {
    listen ${listenPort};

    location / {
        proxy_pass http://app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }

    location ${healthCheckPath} {
        proxy_pass http://app${healthCheckPath};
        proxy_connect_timeout 3s;
        proxy_read_timeout 5s;
    }

    include ${NGINX_SNIPPETS_DIR}/*.conf;
}
`;
}

// ── Canary Weight Calculator ────────────────────────────────────

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function calculateCanaryWeights(canaryPercent: number): {
  readonly stableWeight: number;
  readonly canaryWeight: number;
} {
  if (canaryPercent <= 0) return { stableWeight: 1, canaryWeight: 0 };
  if (canaryPercent >= 100) return { stableWeight: 0, canaryWeight: 1 };

  const stablePercent = 100 - canaryPercent;
  const divisor = gcd(stablePercent, canaryPercent);

  return {
    stableWeight: stablePercent / divisor,
    canaryWeight: canaryPercent / divisor,
  };
}

// ── Config Deployment ───────────────────────────────────────────

export async function writeNginxConfig(
  proxyContainerName: string,
  config: string,
): Promise<void> {
  // Write config via docker exec + sh -c with heredoc
  const result = await execa(
    "docker",
    [
      "exec",
      proxyContainerName,
      "sh",
      "-c",
      `cat > /etc/nginx/conf.d/default.conf << 'NGINX_EOF'\n${config}NGINX_EOF`,
    ],
    { reject: false },
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to write nginx config to ${proxyContainerName}: ${result.stderr}`,
    );
  }
}

export async function reloadNginx(
  proxyContainerName: string,
): Promise<void> {
  // Test config first
  const testResult = await execa(
    "docker",
    ["exec", proxyContainerName, "nginx", "-t"],
    { reject: false },
  );

  if (testResult.exitCode !== 0) {
    throw new Error(
      `Nginx config test failed in ${proxyContainerName}: ${testResult.stderr}`,
    );
  }

  // Reload
  const reloadResult = await execa(
    "docker",
    ["exec", proxyContainerName, "nginx", "-s", "reload"],
    { reject: false },
  );

  if (reloadResult.exitCode !== 0) {
    throw new Error(
      `Nginx reload failed in ${proxyContainerName}: ${reloadResult.stderr}`,
    );
  }
}

// ── Snippets ────────────────────────────────────────────────────

/** Read a snippet from the proxy; null when it doesn't exist. */
export async function readNginxSnippet(
  proxyContainerName: string,
  name: string,
  dir: string = NGINX_SNIPPETS_DIR,
): Promise<string | null> {
  const result = await execa(
    "docker",
    ["exec", proxyContainerName, "cat", `${dir}/${name}.conf`],
    // Keep the file byte-for-byte so callers can compare it to what they'd write
    { reject: false, stripFinalNewline: false },
  );
  return result.exitCode === 0 ? String(result.stdout) : null;
}

/**
 * Install (or replace) a snippet and reload nginx. If the new config fails
 * `nginx -t`, the snippet is removed again so the proxy keeps serving.
 */
export async function writeNginxSnippet(
  proxyContainerName: string,
  name: string,
  content: string,
  /** NGINX_SNIPPETS_DIR (server level) or NGINX_HTTP_DIR (http level) */
  dir: string = NGINX_SNIPPETS_DIR,
): Promise<void> {
  const file = `${dir}/${name}.conf`;
  const write = await execa(
    "docker",
    [
      "exec",
      proxyContainerName,
      "sh",
      "-c",
      `mkdir -p ${dir} && cat > ${file} << 'NGINX_EOF'\n${content}NGINX_EOF`,
    ],
    { reject: false },
  );
  if (write.exitCode !== 0) {
    throw new Error(`Failed to write nginx snippet ${name}: ${write.stderr}`);
  }

  try {
    await reloadNginx(proxyContainerName);
  } catch (err) {
    await execa("docker", ["exec", proxyContainerName, "rm", "-f", file], { reject: false });
    throw err;
  }
}

/** Remove a snippet (if present) and reload nginx. */
export async function removeNginxSnippet(
  proxyContainerName: string,
  name: string,
  dir: string = NGINX_SNIPPETS_DIR,
): Promise<void> {
  if ((await readNginxSnippet(proxyContainerName, name, dir)) === null) return;
  await execa("docker", ["exec", proxyContainerName, "rm", "-f", `${dir}/${name}.conf`], { reject: false });
  await reloadNginx(proxyContainerName);
}
