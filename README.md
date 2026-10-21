# DeployX

Self-hosted CI/CD platform: YAML pipelines executed as a DAG on your own
machines ("runners"), multi-strategy Docker deployments (blue-green, canary,
rolling) with self-healing, and a real-time dashboard.

**Live:** [deployx-chi.vercel.app](https://deployx-chi.vercel.app) — sign in with GitHub.

- [How it works](#how-it-works)
- [Getting started](#getting-started) — pick one of three paths
- [Running a runner](#running-a-runner)
- [Self-hosting the control plane](#self-hosting-the-control-plane)
- [Pipeline YAML reference](#pipeline-yaml-reference)
- [Roles and permissions](#roles-and-permissions)
- [Development](#development) · [Troubleshooting](#troubleshooting) · [Documentation](#documentation)

## Features

- **YAML pipelines** — tasks with `depends_on` run as a DAG (parallel where possible), with per-step timeouts, env, artifacts and approval gates
- **Your machines run the work** — runners poll the control plane (no open ports); pick **any available runner** or pin a run to a specific one
- **Deployment strategies** — blue-green (instant cutover), canary (staged traffic), rolling; behind an nginx proxy per project
- **Temporary public URLs** — every local deployment gets a `https://….trycloudflare.com` link for 24 hours
- **Project documents** — upload files to a project; public ones are served on the deployment URL under `/files/` from an S3-compatible object store on the runner (versioned, erasure-coded), private ones through short-lived signed links
- **Self-healing** — health checks every 15s, restarts with backoff, automatic rollback
- **Real-time dashboard** — live logs and DAG, deployment health, SLA uptime, build-time prediction, failure risk
- **Runner resource usage** — CPU, memory, disk and container load per runner, plus 24h job stats
- **Triggers** — manual, GitHub push webhooks (branch filters), cron schedules (time zones)
- **Teams** — orgs, invite links, Owner/Admin/Developer/Viewer roles enforced by the server and Row Level Security
- **Secrets** — AES-256-GCM encrypted project secrets, injected only at run time
- **Alerts & notifications** — threshold alerts (success rate, duration, health), in-app realtime notifications, audit log
- **Pipeline versioning** — edit, browse history, restore any version, re-run any run

## How it works

```
 Browser ──HTTPS──▶ Control plane: Next.js app on Vercel (apps/web)
    ▲                 │  pages, server actions, /api/runner/*, /api/webhooks, /api/cron/tick
    │ Realtime        ▼
    └──────────── Supabase: Postgres (+RLS), Auth (GitHub OAuth), Realtime, Storage, pg_cron
                      ▲
                      │ HTTPS polling: heartbeat + metrics (10s/30s), job poll (5s),
                      │ logs, status, deployments
 Runner machine ──────┘  (apps/runner — your laptop, a server, WSL2…)
   ├─ clones the repo, runs steps with `sh -c` (optionally inside a Docker image)
   ├─ builds images, deploys app containers behind an nginx proxy (deployx-net)
   ├─ health monitor: checks every 15s, restarts / rolls back
   └─ cloudflared tunnel → temporary public URL for the deployment
```

1. A run is created (button, webhook or schedule) and **queued** in Postgres.
2. A runner in the project's organization claims it atomically, clones the repo and executes the DAG, streaming logs and status back.
3. A task with a `deploy:` block builds and deploys the image with the chosen strategy; the dashboard updates live over Supabase Realtime.
4. A once-a-minute **platform tick** (`pg_cron` → `/api/cron/tick`) fires schedules, reaps runs whose runner died, evaluates alerts and expires old data.

## Getting started

| You want to… | Do this |
|---|---|
| **Try it / use the hosted app** | Sign in at [deployx-chi.vercel.app](https://deployx-chi.vercel.app), create a project, then [run a runner](#running-a-runner) so pipelines have somewhere to execute. Step-by-step: [Getting started guide](docs/context/19-getting-started.md). |
| **Run pipelines on your machine** | [Running a runner](#running-a-runner) — no env file or database needed. |
| **Host your own DeployX** | [Self-hosting the control plane](#self-hosting-the-control-plane). |

A project needs a Git repo with a `Dockerfile` whose app listens on `PORT`
(default 3000) and answers `GET /health` with 200. See
[`examples/demo-app`](examples/demo-app) (JSON API) and
[`examples/demo-app2`](examples/demo-app2) (HTML site).

## Running a runner

A runner is the agent that executes pipelines and hosts `docker_local`
deployments on your machine. It polls the control plane, so it needs no open
ports.

**You need:** Node 20+, pnpm (`corepack enable`), Git, and Docker running.

```bash
git clone https://github.com/epshukla/DevOps-Deployment-Tool.git
cd DevOps-Deployment-Tool
pnpm install

# Runners page → "Register Runner" shows this command with a one-time token
pnpm runner register --token <token> --url https://deployx-chi.vercel.app
pnpm runner start
```

`pnpm runner` builds the runner automatically on first use (and again after a
`git pull` changes its sources), so there is no separate build step. The
registration is saved to `~/.deployx/runners/<name>.json`; no `.env` is needed.
Other commands: `pnpm runner list`, `pnpm runner status`, `pnpm runner
unregister`; use `--name` when registering and `--profile <name>` to keep
several registrations on one machine. More: [`apps/runner/README.md`](apps/runner/README.md).

**Windows:** run the runner inside **WSL2**, not PowerShell or cmd. Pipeline
steps run through `sh` and mount the workspace into Docker, which needs a Linux
shell, and paths with spaces (e.g. under OneDrive) break the mounts.

1. Install WSL with Ubuntu: `wsl --install -d Ubuntu` (PowerShell as admin), then reboot.
2. Docker Desktop → Settings → Resources → WSL integration → enable Ubuntu.
3. In the Ubuntu terminal, install Node 20+ (e.g. via `nvm`), then follow the
   steps above. Clone into the Linux home directory (`cd ~`), not `/mnt/c/...`.

**Which runner runs a job?** Runners belong to an organization. By default any
online runner in the project's org can claim a queued run (first to poll wins).
To pin a run to one machine, pick it under **Run on** in the Trigger Pipeline
menu; only that runner will claim it (it waits in the queue while that runner
is offline), and re-runs stay on the same runner. The run page and the
project's run list show which runner ran each run. Pipeline steps run with
the runner's permissions on that machine, so only register runners for
organizations you trust.

**Resource usage.** Every 30 seconds a runner reports host CPU, memory and disk
plus the CPU/memory of the DeployX containers it hosts. The Runners page shows
this per runner with a one-hour chart and 24-hour job stats (jobs, busy time,
success rate). History older than 24 hours is pruned by the platform tick.

## Self-hosting the control plane

You need: Node 20+, pnpm 10 (`corepack enable`), a [Supabase](https://supabase.com)
project, a GitHub account, and (to deploy) a Vercel account.

```bash
git clone https://github.com/epshukla/DevOps-Deployment-Tool.git
cd DevOps-Deployment-Tool
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill it in (step 3)
```

1. **Database.** Create a Supabase project, then apply the schema:

   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push          # applies supabase/migrations/* in order
   ```

2. **GitHub sign-in.** Create a GitHub OAuth app (GitHub → Settings → Developer
   settings → OAuth Apps) with callback URL
   `https://<your-project-ref>.supabase.co/auth/v1/callback`. In Supabase →
   Authentication → Sign In / Providers → **GitHub**, enable it and paste the
   client ID and secret. Then, under Authentication → URL Configuration:
   - **Site URL:** your app URL (e.g. `https://deployx-chi.vercel.app`)
   - **Redirect URLs:** `https://<your-app>/auth/callback`, plus
     `http://localhost:3000/auth/callback` for local development (without it,
     signing in from localhost lands on the production URL)

3. **Environment.** Fill in `apps/web/.env.local` — every variable is explained
   in [`apps/web/.env.example`](apps/web/.env.example):

   | Variable | What it is |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (public) key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key — **secret**, server only |
   | `DEPLOYX_SECRET_KEY` | Encrypts project secrets, GitHub tokens, webhook secrets — **secret** (`openssl rand -hex 32`) |
   | `CRON_SECRET` | Bearer token for `/api/cron/*` — **secret** (`openssl rand -hex 32`) |
   | `NEXT_PUBLIC_DISPLAY_TIME_ZONE` | Optional display time zone (default `Asia/Kolkata`) |

4. **Run locally:** `pnpm dev` → [http://localhost:3000](http://localhost:3000)
   (also rebuilds the runner on change).

5. **Deploy to Vercel.** Import the repo with **Root Directory = `apps/web`**,
   add the same environment variables (Production), and deploy. Functions are
   pinned to `sin1` in `apps/web/vercel.json` to sit next to a Singapore
   Supabase project — change the region to match yours. When adding variables
   from a shell, use `printf '%s' "$VALUE" | vercel env add NAME production`
   (`echo` adds a newline that breaks the Realtime connection).

6. **Platform tick.** `/api/cron/tick` must be called once a minute. Each call
   dispatches due schedules (claimed atomically, never double-fired), marks
   runners that stopped heartbeating offline and times out runs they orphaned,
   evaluates alert rules, expires public URLs and prunes runner metrics.
   Migration `20261012000024_realtime_and_cron_tick.sql` schedules it with
   **pg_cron + pg_net** (works on every plan; Vercel Hobby crons are daily
   only). Store the URL and the same `CRON_SECRET` in Supabase Vault (SQL editor):

   ```sql
   select vault.create_secret('https://<your-app>/api/cron/tick', 'deployx_tick_url');
   select vault.create_secret('<CRON_SECRET value>', 'deployx_cron_secret');
   ```

   Until both exist the job is a no-op. Check it with
   `select * from cron.job_run_details order by start_time desc limit 5;`.

Then sign in, and register a runner from the Runners page — the dialog fills
in your app's URL for `--url` automatically.

> **Local Supabase** (`npx supabase start` + `npx supabase db reset`) also
> works, but GitHub sign-in needs an `[auth.external.github]` section in
> `supabase/config.toml` with your OAuth app's credentials (callback
> `http://127.0.0.1:54321/auth/v1/callback`).

## Pipeline YAML reference

```yaml
name: build-and-deploy
tasks:
  test:
    steps:
      - name: Install
        command: npm ci
      - name: Test
        command: npm test
        timeout_seconds: 600        # step is killed and failed after this
        env: { NODE_ENV: test }
        # image: node:20            # optional: run the step inside this container

  build:
    depends_on: [test]
    approval_required: true         # pauses in "awaiting approval" until reviewed on the run page
    required_approvals: 2           # optional, default 1; any rejection fails the task
    artifacts: [dist/*.tar.gz]      # uploaded after the task succeeds (paths inside the repo)
    steps:
      - name: Build image
        command: docker build -t my-app:${{ git.short_sha }} .
    deploy:
      driver: docker_local          # docker_local | railway | fly_io
      strategy: blue_green          # blue_green | canary | rolling
      port: 3000
      image: my-app:${{ git.short_sha }}   # omit → the runner builds from the project's Dockerfile
      health_check:
        path: /health
      public_url: true              # default; false = no temporary public URL
```

**Variables:** `${{ git.sha }}`, `${{ git.short_sha }}`, `${{ git.branch }}`,
`${{ project.name }}`, `${{ project.slug }}`, `${{ env.NAME }}` (project secrets
and variables, set in Project Settings).

**Public URLs.** `docker_local` deployments get a temporary public HTTPS URL
through a Cloudflare quick tunnel (`https://<words>.trycloudflare.com`): no
account or domain needed. The runner starts a `cloudflared` container next to
the project's nginx proxy, so blue-green / canary / rolling switching still
works behind the URL. The link is shown on the deployment page and dashboard,
is reused across redeploys, and is removed after **24 hours** (or when the
deployment is stopped). It only works while the runner's machine and Docker are up.

**Documents.** Files uploaded on a project's **Documents** tab are served on
the same URL under `/files/<path>` (public ones only). The runner mirrors them
into a local S3-compatible object store (`rustfs/rustfs`, started the first
time a project has documents) within a minute of each change.

**Project secrets read by the runner:** `DEPLOYX_REGISTRY` (e.g.
`ghcr.io/acme`; when set, built images are tagged and pushed there — required
for Railway/Fly), `RAILWAY_PROJECT_TOKEN`, `RAILWAY_ENVIRONMENT_ID`.

## Roles and permissions

| Action | Viewer | Developer | Admin | Owner |
|---|:-:|:-:|:-:|:-:|
| See projects, runs, logs, deployments, runners, alerts | ✓ | ✓ | ✓ | ✓ |
| Create projects and pipelines, edit/restore pipeline versions | | ✓ | ✓ | ✓ |
| Trigger, re-run, cancel runs; vote on approvals | | ✓ | ✓ | ✓ |
| Manage secrets, webhooks, schedules; stop / roll back deployments | | ✓ | ✓ | ✓ |
| Upload, delete, restore and publish documents | | ✓ | ✓ | ✓ |
| Register / revoke runners; manage alert rules | | | ✓ | ✓ |
| Invite members, change roles, delete projects and artifacts | | | ✓ | ✓ |
| Rename the organization | | | | ✓ |

Viewers see every control but greyed out, with the reason on hover. Rules are
enforced in server actions and by Postgres Row Level Security, not only in the UI.

## Development

```
DevOps-Deployment-Tool/
├── apps/
│   ├── web/              # Next.js 16 control plane: UI, server actions, runner/webhook/cron APIs
│   └── runner/           # Runner CLI: polls jobs, executes the DAG, deploys, health-checks, metrics
├── packages/
│   ├── shared/           # Zod validators, types, constants, crypto (used by web + runner)
│   └── pipeline-engine/  # YAML parser, DAG resolver, run/task/deployment state machines
├── supabase/migrations/  # Database schema, RLS policies, functions — applied in filename order
├── scripts/runner.mjs    # `pnpm runner` launcher (builds the runner when needed)
├── examples/             # demo-app (JSON API) and demo-app2 (HTML site) to deploy with DeployX
├── design-system/        # UI design rules (colours, type, components)
└── docs/context/         # Feature write-ups and the getting-started guide
```

| Command | What it does |
|---|---|
| `pnpm dev` | Web app on :3000 + runner rebuild on change (Turborepo) |
| `pnpm build` | Build every package |
| `pnpm test` | Run all test suites (Vitest) |
| `pnpm lint` | Lint every package |
| `pnpm --filter web test` / `pnpm --filter @deployx/runner test` | One package's tests |

Tests live next to the code in `__tests__/` folders. New database changes go in
a new file `supabase/migrations/<YYYYMMDD><NNNNNN>_<name>.sql` (idempotent where
possible) and are applied with `npx supabase db push`. Next.js 16 differs from
older versions (e.g. `proxy.ts` instead of `middleware.ts`, async `params`) —
see `apps/web/AGENTS.md`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Run stays **queued** | No runner online in the project's org — start one (`pnpm runner start`). If the run says "Waiting for <runner>", it was pinned to that runner |
| `Cannot find module …/apps/runner/dist/cli.js` | Old checkout: `git pull` — `pnpm runner` now builds itself |
| Runner steps fail on Windows | Use WSL2 (see [Running a runner](#running-a-runner)) |
| Dashboard doesn't update live | Supabase URL/anon key has a trailing newline in the host's env; re-add with `printf '%s'` and redeploy |
| Health check failing | The app must read `PORT` and answer `GET /health` with 200 |
| Webhook not triggering | Check GitHub's delivery log; the secret must match the one shown in Project Settings → Webhooks |
| Sign-in from localhost lands on production | Add `http://localhost:3000/auth/callback` to Supabase Redirect URLs |
| Vercel build fails with `next/font/google queries have exactly one entry` | Transient Google Fonts download failure at build time — redeploy |

More in the [getting-started guide](docs/context/19-getting-started.md#troubleshooting).

## Documentation

- **[Getting started guide](docs/context/19-getting-started.md)** — from first sign-in to a running deployment
- [`apps/runner/README.md`](apps/runner/README.md) — runner CLI, config, how jobs execute
- [`apps/web/README.md`](apps/web/README.md) — control plane structure and APIs
- [`apps/web/.env.example`](apps/web/.env.example) — every environment variable
- [`design-system/deployx/MASTER.md`](design-system/deployx/MASTER.md) — UI design rules

Feature write-ups in [`docs/context/`](docs/context/) (written while each
feature was built; the code and this README win where they disagree):

| Doc | Topic |
|-----|-------|
| [01](docs/context/01-project-overview.md) | Architecture & tech stack |
| [02](docs/context/02-auth-setup.md) | OAuth, protected routes |
| [03](docs/context/03-pages-and-routes.md) | Route map |
| [04](docs/context/04-database-schema.md) | Tables, RLS, enums |
| [05](docs/context/05-crud-wiring.md) | Data flow, server actions |
| [06](docs/context/06-pipeline-engine.md) | YAML parser, DAG, state machine |
| [07](docs/context/07-container-factory.md) | Docker build, variable interpolation |
| [08](docs/context/08-orchestrator.md) | Blue-green deployment, nginx, health checks |
| [09](docs/context/09-self-healing.md) | Health monitor, remediation, auto-rollback |
| [10](docs/context/10-observability.md) | DAG visualization, live logs, metrics |
| [11](docs/context/11-secrets-and-actions.md) | Encryption, cancel/approve actions |
| [12](docs/context/12-roadmap.md) | Phase overview |
| [13](docs/context/13-team-management.md) | RBAC, invites, permissions |
| [14](docs/context/14-webhook-triggers.md) | GitHub push events, HMAC verification |
| [15](docs/context/15-scheduled-triggers.md) | Cron execution |
| [16](docs/context/16-canary-rolling.md) | Canary and rolling strategies |
| [17](docs/context/17-external-deployers.md) | Railway & Fly.io |
| [18](docs/context/18-advanced-observability.md) | SLA, alerts, notifications, audit |
| [19](docs/context/19-getting-started.md) | Getting started guide |
| [20](docs/context/20-ui-security-fixes.md) | UI & security patches |
| [21](docs/context/21-deployment-bugfixes.md) | Deployment bug fixes |
| [22](docs/context/22-multi-runner-profiles.md) | Multiple runners on one machine |
| [23](docs/context/23-project-documents.md) | Project documents: object storage, `/files/` on the public URL |

## License

[MIT](LICENSE)
