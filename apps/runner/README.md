# DeployX runner

The agent that executes pipelines. It runs on a machine you control (laptop,
server, WSL2), polls the control plane over HTTPS — no inbound ports — and for
`docker_local` deployments also hosts the deployed app.

## Requirements

Node 20+, pnpm (`corepack enable`), Git, and a running Docker engine the
current user can use (`docker ps` works). Linux or macOS; on Windows use WSL2
(see the root README). Pipeline steps run with this user's permissions, so
only register the runner with organizations you trust.

## Commands

Run from the repo root. `pnpm runner` builds the runner (and the workspace
packages it uses) on first use and whenever the sources changed, via
`scripts/runner.mjs`.

```bash
pnpm runner register --token <token> --url https://deployx-chi.vercel.app [--name my-laptop]
pnpm runner start   [--profile my-laptop]   # poll for jobs until Ctrl+C
pnpm runner status  [--profile my-laptop]   # registration + connectivity
pnpm runner list                            # all profiles on this machine
pnpm runner unregister [--profile my-laptop]
```

The token comes from the dashboard: **Runners → Register Runner** (admins). It
is shown once and binds the runner to that organization.

## Files it keeps

| Path | Contents |
|---|---|
| `~/.deployx/runners/<profile>.json` | Control-plane URL, runner name/id and token (one per profile; keep it private) |
| `~/.deployx/ports.json` | Host ports handed out to deployments (range 10000–10999) |
| `$TMPDIR/deployx-<run>-*` | Per-run workspace (the cloned repo), removed after the run |

No environment variables or `.env` file are needed.

## What `start` does

| Loop | Interval | |
|---|---|---|
| Heartbeat | 10s | keeps the runner "online"; every 30s it also carries host CPU/memory/disk and DeployX-container CPU/memory (shown on the Runners page) |
| Job poll | 5s | takes the oldest queued run in its org that is unpinned or pinned to this runner, then claims it atomically |
| Health monitor | 15s | probes each deployment's health endpoint; restarts (3 attempts, backoff from 5s) and rolls back when unhealthy; removes expired public-URL tunnels |

One job runs at a time per runner. For a job it:

1. clones the repo (a stored GitHub token is used for private repos) and records the commit;
2. loads project secrets and resolves `${{ … }}` variables;
3. runs tasks in DAG order — groups of independent tasks in parallel — each step via `sh -c` (or `docker run … sh -c` when the step sets `image:`), streaming logs and honouring timeouts, cancellation and approval gates;
4. uploads `artifacts:` after a task succeeds;
5. for a task with `deploy:`, deploys with the chosen strategy and opens the public URL;
6. reports the final status.

## Deployments (`driver: docker_local`)

Every project gets an nginx proxy container (`deployx-proxy-<slug>`) on the
`deployx-net` network; app containers sit behind it, so switching versions
never changes the address.

- **blue_green** — start the new colour, wait for health, switch nginx, drain the old one (10s) and remove it
- **canary** — shift traffic in stages (10% → 25% → 50% → 100%), observing health at each stage; roll back on failure
- **rolling** — run several instances (`rolling.instances`) and replace them in batches of `rolling.max_unavailable`, checking health after each

`deployx-tunnel-<slug>` (cloudflared) exposes the proxy at a temporary
`https://….trycloudflare.com` URL for 24 hours; set `public_url: false` in the
deploy block to skip it. `railway` and `fly_io` drivers push the image to
`DEPLOYX_REGISTRY` and deploy there instead.

## Source map

```
src/
├── cli.ts, commands/      # register / start / status / list / unregister
├── config.ts              # ~/.deployx/runners/<profile>.json profiles
├── api-client.ts          # control-plane HTTP client
├── metrics.ts             # host + Docker usage sampling
├── executor/              # pipeline → task → step execution, workspace, variables,
│                          #   approvals, artifacts, image builds, cancellation
├── deployers/             # docker_local strategies, nginx config, health monitor,
│                          #   remediation, port allocator, public tunnel, Railway, Fly
├── docker/, logging/      # Docker CLI wrapper, batched log streaming
```

Tests: `pnpm --filter @deployx/runner test`.
