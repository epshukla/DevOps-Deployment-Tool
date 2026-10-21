# Setting up the new features

The live stack already exists: the Supabase project `hrnjmwnbidotpqqtmtxw` (Postgres, Auth
with GitHub OAuth, Storage, pg_cron tick) and the Vercel project `deployx-chi` (web app,
env vars set). This guide covers only what the new features need on top of that.

## 1. Database (required)

Two new migrations:

- `030_project_documents`: documents table, `project-documents` bucket, storage RLS
- `031_mfa_notifications_verification`: `require_mfa`, `notify_webhook_url`,
  document verification columns

```bash
npx supabase login
npx supabase link --project-ref hrnjmwnbidotpqqtmtxw
npx supabase db push
```

Check it worked: Table Editor shows `project_documents`, and Storage shows the
`project-documents` bucket (private, 25 MB limit).

## 2. Vercel (required: deploy the new code)

No new environment variables. Merge the branch into `main`; Vercel deploys it.
To try it first, open the branch's preview deployment. Preview sign-in needs the preview
URL under Supabase → Authentication → URL Configuration → Redirect URLs (a wildcard
`https://*-<team>.vercel.app/auth/callback` covers all previews).

## 3. MFA (on by default)

Supabase → Authentication → Sign In / Providers → **Multi-Factor**: TOTP must be enabled.
It is on by default for hosted projects.

- Each user enables it under Settings → Security & integrations → **Set up**, or at `/mfa`.
- The owner can tick **Require MFA for Owners and Admins**. Set up your own MFA first:
  the app refuses the setting until you have.

## 4. Edge Function: document verification (optional)

```bash
npx supabase functions deploy verify-document --no-verify-jwt
npx supabase secrets set DOCUMENT_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

Then create a Database Webhook (Supabase → Database → Webhooks → Create):

- Table: `project_documents`, events: **Update**
- Type: HTTP Request, `POST https://hrnjmwnbidotpqqtmtxw.supabase.co/functions/v1/verify-document`
- HTTP header: `x-webhook-secret: <the same value>`

New uploads then show **verified** in the Documents tab. A mismatch makes the document
private automatically.

## 5. Runners (required for documents, scanning, rate limits)

On each runner machine (WSL2 on Windows):

```bash
git pull && pnpm install     # new dependency: @aws-sdk/client-s3
pnpm runner start
```

Docker images are pulled only when a feature is used:

| Image | When | Size |
|---|---|---|
| `rustfs/rustfs:1.0.3` | first time a hosted project has documents | ~420 MB |
| `aquasec/trivy:0.65.0` (+ ~60 MB vulnerability DB volume) | a deploy with `security_scan` | ~200 MB |
| `nginx:alpine`, `cloudflare/cloudflared` | already used before | |

Free the space when you're done:

```bash
docker rm -f deployx-objectstore
```

```bash
docker volume rm deployx-objectstore-d1 deployx-objectstore-d2 deployx-objectstore-d3 deployx-objectstore-d4 deployx-objectstore-meta deployx-trivy-cache
```

```bash
docker image prune -a
```

Existing project proxies get the `/files/` route on their **next deploy** (the include
line is new).

## 6. Using the features

```yaml
deploy:
  driver: auto                 # cloud broker; or docker_local | railway | fly_io
  broker:
    prefer: [docker_local, fly_io]
  security_scan:               # Trivy before deploy
    severity: [HIGH, CRITICAL]
    fail_on_findings: true
  rate_limit:                  # control layer: 429 above this per client
    requests_per_second: 10
    burst: 20
  resources: { cpus: 0.5, memory_mb: 512 }
  volumes:
    - { name: data, path: /app/data }
```

- **Documents**: project → Documents tab → upload. Public files show up at
  `<public URL>/files/<path>` within a minute.
- **Secret masking**: automatic. Secrets marked secret print as `***` in run logs.
- **Notification webhook**: Settings → Security & integrations. Paste a Slack or
  Discord incoming-webhook URL (owner only).

## 7. Go probe (optional)

```bash
docker build -t deployx-probe tools/probe
```

```bash
docker run --rm deployx-probe -n 50 -c 10 -min-success 0.99 https://<public-url>/health
```

As a pipeline step after the deploy task:

```yaml
smoke:
  depends_on: [build]
  steps:
    - name: Probe
      command: docker build -q -t deployx-probe tools/probe && docker run --rm deployx-probe -n 30 http://host.docker.internal:<proxy-port>/health
```

## 8. Infrastructure as Code (optional)

`infra/terraform` describes the Supabase project, its auth settings (GitHub OAuth, TOTP)
and the Vercel project with its env vars.

```bash
cd infra/terraform && cp deployx.tfvars.example deployx.tfvars   # fill in
terraform init
terraform import supabase_project.deployx hrnjmwnbidotpqqtmtxw   # adopt existing
terraform import vercel_project.web <vercel-project-id>
terraform plan -var-file=deployx.tfvars
```

`deployx.tfvars` and the state files are gitignored because they contain secrets.

## 9. Disaster recovery

```bash
SUPABASE_DB_URL='postgresql://postgres.hrnjmwnbidotpqqtmtxw:<db-password>@<pooler-host>:5432/postgres' sh scripts/dr/backup.sh
```

```bash
SUPABASE_DB_URL='...' sh scripts/dr/restore.sh backups/<timestamp>
```

- Backups land in `backups/` (gitignored), with `SHA256SUMS`; the newest 7 are kept.
  They contain the `public` schema dump and every `deployx-*` Docker volume.
- **Strategy:** backup & restore. Auth users and Storage objects are covered by
  Supabase's own daily backups.
- **RPO:** time since the last `backup.sh` (schedule it daily with cron).
- **RTO:** about 30 minutes:
  1. new Supabase project
  2. `db push`
  3. `restore.sh`
  4. update Vercel env (or `terraform apply`)
  5. re-register runners

Volume backup and restore was tested end to end.
