# DeployX ↔ Cloud Computing course (702IT0C026) mapping

How each unit and lab of the course policy shows up in the project, with the file to
open during a demo.

## Units

| Unit / topic | Where in DeployX | Files |
|---|---|---|
| **U1** Essential characteristics | On-demand self-service: trigger a run or deploy from the dashboard. Resource pooling: org runner pool. Measured service: runner CPU/mem/disk metrics, run durations. Rapid elasticity: canary/rolling instances | `apps/runner/src/metrics.ts`, `components/runners/runner-usage-card.tsx` |
| **U1** Service models | DeployX is PaaS for its users. Supabase is BaaS/DBaaS, Vercel is serverless PaaS, Railway/Fly are PaaS targets, the runner host is IaaS-like | README "How it works" |
| **U1** Deployment models | Hybrid: public-cloud control plane (Vercel + Supabase) with private runners on your own machines | README |
| **U1** Cloud service brokerage | `driver: auto` + `broker.prefer` picks the first usable target (local Docker → Railway → Fly) | `packages/shared/src/validators/deployment.ts` (`chooseDeployTarget`), `apps/runner/src/executor/deployment-executor.ts` |
| **U1** Reference model | Physical: runner host disks. Virtual: Docker containers and volumes. Control: scheduler, health monitor, nginx. Service: dashboard and APIs | `docs/context/01-project-overview.md` |
| **U2** Block storage | Persistent named volumes per project (`deploy.volumes`) | `apps/runner/src/deployers/app-runtime.ts`, doc 24 |
| **U2** File storage | Run workspaces and build artifacts | `apps/runner/src/executor/workspace.ts` |
| **U2** Object storage | Project documents: Supabase Storage (origin) plus an S3-compatible store on each runner (RustFS), served at `/files/` | doc 23 |
| **U2** RAID, parity, mirroring | The runner's object store erasure-codes every object across 4 drives (data + parity shards) | `apps/runner/src/documents/object-store.ts` |
| **U3** Virtualization, resource pooling | Containers per deployment. Runner pool per org. CPU/memory/pids cgroup limits | `container-manager.ts`, doc 24 |
| **U3** Hypervisor | Runners on Windows run inside WSL2 (Hyper-V, type 1). Docker Desktop runs a Linux VM | README "Running a runner" |
| **U4** Resource discovery & provisioning | Runner registration and heartbeat. Job claim. Pinning a run to a runner | `apps/web/src/app/api/runner/*` |
| **U4** Load balancing | nginx upstreams per project, weighted for canary, multi-instance for rolling | `apps/runner/src/deployers/nginx-config.ts` |
| **U4** QoS / traffic shaping | `deploy.rate_limit`: per-client token bucket (nginx `limit_req`, 429) | `apps/runner/src/deployers/rate-limit.ts` |
| **U4** Monitoring & self-healing | Health checks every 15 s, restart with backoff, auto-rollback, SLA uptime, alerts | `health-monitor.ts`, `remediation-engine.ts` |
| **U4** Cache tiering | `Cache-Control` on `/files/`, the Cloudflare edge in front of the proxy | `documents/document-sync.ts` |
| **U5** Threats & mechanisms | AES-256-GCM secrets. HMAC webhooks. RLS. Secret masking in logs. Trivy image scanning (`deploy.security_scan`). SHA-256 integrity checks on documents | `packages/shared/src/crypto.ts`, `logging/log-streamer.ts`, `executor/security-scan.ts` |
| **U5** DMZ | Only the nginx proxy is reachable (through the tunnel). Apps and the object store sit on a private Docker network, and the store's API is bound to 127.0.0.1 | `public-tunnel.ts`, `object-store.ts` |
| **U5** IAM | Orgs with Owner/Admin/Developer/Viewer roles, enforced in server actions and Postgres RLS | `lib/permissions.ts`, `supabase/migrations/*rls*` |
| **U5** OAuth / OpenID Connect | GitHub OAuth through Supabase Auth (PKCE). Supabase issues OIDC-style JWTs | `lib/auth/*`, `app/auth/callback` |
| **U5** MFA | TOTP enrollment and verification at `/mfa`. Enrolled users must reach AAL2. Owners can require MFA for Owners/Admins | `lib/auth/mfa.ts`, `app/mfa/*`, migration 031 |
| **U5** Kerberos | Not used. Explained in the report: ticket-based SSO for on-prem networks; DeployX uses token-based OAuth/JWT instead |  |
| **U6** Orchestration | YAML pipelines as a DAG. Deploy strategies (blue-green, canary, rolling). Approval gates | `packages/pipeline-engine`, `deployers/*` |
| **U6** Docker, Dockerfile | Image builds, multi-stage Dockerfile (`tools/probe/Dockerfile`), container lifecycle | `executor/image-builder.ts` |
| **U6** Kubernetes | Not implemented. Rolling, health probes and self-healing are the same ideas as K8s Deployments and liveness probes |  |

## Labs

| Lab | Where |
|---|---|
| 1 Well-Architected | Reliability (self-healing, rollback, DR scripts). Security (RLS, MFA, scanning). Cost (runs on your own machines) |
| 2 IAM, S3, versioning, lifecycle, static site | Org RBAC, presigned uploads, bucket versioning, lifecycle rules, public-read policy, `/files/` static serving |
| 3 Compute & databases | Runners as compute. Supabase Postgres as managed DB (RDS equivalent) |
| 5 Monitoring, auto scaling, load balancing | Health monitor, SLA, alerts, runner metrics, nginx load balancing |
| 6 IaC | `infra/terraform`: Supabase project, auth settings, Vercel project and env (CloudFormation equivalent) |
| 7 Caching | Cache headers on `/files/`, Cloudflare edge |
| 8 Decoupled (SQS/SNS) | Runs are queued in Postgres and claimed by runners (queue). Notification webhook fan-out to Slack/Discord (pub/sub) |
| 9 Serverless | Next.js API routes on Vercel Functions. pg_cron platform tick. Supabase Edge Function `verify-document`, triggered by a Database Webhook |
| 11 Disaster recovery | `scripts/dr/backup.sh` / `restore.sh` (backup & restore strategy). Rollback to the previous image. Documented RPO/RTO in `docs/SETUP.md` |
| 12 Go for cloud automation | `tools/probe`: concurrent HTTP prober (latency percentiles, gates a pipeline) |
| 13 Virtualization / containers | Docker deployments, cgroup limits, volumes |
