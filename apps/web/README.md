# DeployX web app (control plane)

Next.js 16 (App Router) app that serves the dashboard and the APIs runners,
GitHub and the scheduler talk to. Data, auth, realtime and file storage are
Supabase. Production: [deployx-chi.vercel.app](https://deployx-chi.vercel.app).

> This is **Next.js 16**: `src/proxy.ts` replaces `middleware.ts`, route
> `params` are async, and some APIs differ from older docs. Check
> `node_modules/next/dist/docs/` before relying on memory (see `AGENTS.md`).

## Run it

```bash
# from the repo root
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in; every variable is explained there
pnpm --filter web dev                          # http://localhost:3000
```

Sign-in is GitHub OAuth through Supabase; for localhost add
`http://localhost:3000/auth/callback` to the Supabase Redirect URLs. Full setup
(database, OAuth app, Vercel, platform tick): root
[README → Self-hosting](../../README.md#self-hosting-the-control-plane).

| Script | |
|---|---|
| `pnpm --filter web dev` | Dev server |
| `pnpm --filter web build` | Production build (don't run it while `dev` is running — it overwrites `.next`) |
| `pnpm --filter web test` | Vitest unit tests (`src/**/__tests__`) |
| `pnpm --filter web lint` | ESLint (incl. React Compiler rules) |

## Layout

```
src/
├── proxy.ts                 # session refresh + redirect to /login (skips /api/runner, /api/cron, /api/webhooks, /api/notifications)
├── app/
│   ├── (auth)/login         # GitHub sign-in
│   ├── auth/callback        # OAuth callback; stores the GitHub token (encrypted) for private repos
│   ├── invite/[token]       # shareable invite links
│   ├── (dashboard)/         # all signed-in pages: overview, projects, runs, deployments,
│   │                        #   pipelines, runners, alerts, settings, profile
│   │   └── **/actions.ts    # server actions (each checks the caller's role)
│   └── api/
│       ├── runner/*         # runner API (token-authenticated, see below)
│       ├── webhooks/github/[projectId]  # GitHub push → pipeline run (HMAC-verified)
│       ├── cron/tick        # once-a-minute maintenance, called by Supabase pg_cron
│       ├── github/*         # repo / branch pickers for "New Project"
│       └── notifications    # notification feed
├── components/              # UI by feature (dashboard, deployment, runs, runners, projects, ui, layout)
├── hooks/                   # Supabase Realtime subscriptions (run, deployment, notifications)
└── lib/
    ├── supabase/            # browser, server and service-role clients; realtime auth
    ├── auth/                # session/org/role resolution, runner authentication
    ├── cron/                # tick jobs: schedules, orphan reaper, alerts, public-URL expiry, metrics pruning
    └── …                    # permissions, notifications, audit log, formatting, runner usage
```

## How requests are authorized

- **Pages and server actions** use the signed-in user's Supabase session.
  `requireUserWithOrg()` resolves the active organization (org-switcher cookie)
  and the caller's role; mutating actions check it with `hasMinRole()`, and
  Postgres Row Level Security enforces the same rules underneath.
- **The UI** reads the role with `usePermissions()` and greys out what the user
  can't do — that is presentation only, never the security boundary.
- **Runner API** (`/api/runner/*`) authenticates `Authorization: Bearer <runner token>`
  (stored hashed) and uses the service-role client, so every route also checks
  that the run/deployment belongs to the runner's organization.
- **Cron** (`/api/cron/*`) requires `Authorization: Bearer $CRON_SECRET`.
- **Webhooks** verify GitHub's `X-Hub-Signature-256` against the project's secret.

## Runner API

| Endpoint | Used for |
|---|---|
| `POST /api/runner/register` | Claim the runner row pre-created by "Register Runner" (the token shown once is the runner's credential; only its hash is stored) and record name/system info |
| `POST /api/runner/heartbeat` | Liveness every 10s; carries host/Docker metrics every 30s |
| `GET /api/runner/jobs` | Oldest queued run in the runner's org (unpinned, or pinned to this runner) |
| `POST /api/runner/jobs/:runId/claim` | Atomically claim a queued run |
| `POST/GET /api/runner/jobs/:runId/status` | Report run/task/step status; poll for cancellation |
| `POST /api/runner/jobs/:runId/logs` | Batched log lines |
| `GET /api/runner/jobs/:runId/secrets` | Decrypted project secrets for the run |
| `GET /api/runner/jobs/:runId/approvals` | Approval-gate state for a task |
| `POST /api/runner/jobs/:runId/artifacts` · `/images` | Upload artifacts, record built images |
| `POST/PATCH /api/runner/jobs/:runId/deployments[/:id]` | Create/update deployments (status, public URL) |
| `POST …/deployments/:id/health` · `/healing` | Health-check results and self-healing events |

## Deploying

Vercel project with **Root Directory = `apps/web`**; environment variables as in
`.env.example`; functions pinned to `sin1` in `vercel.json` (keep them in the
same region as the Supabase project). From the repo root: `vercel deploy --prod`.
