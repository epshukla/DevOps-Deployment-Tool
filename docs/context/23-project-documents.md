# 23 — Project documents (object storage)

Upload documents to a project and they are served on the deployment's own
public URL, e.g. `https://<words>.trycloudflare.com/files/guides/setup.pdf`.

## Flow

```
Browser ── 1. createDocumentUpload (server action) ──▶ project_documents row (pending, v N)
   │                                                    + signed upload URL
   ├── 2. PUT file straight to Supabase Storage  ──▶ bucket project-documents/{org}/{project}/{doc}
   └── 3. finalizeDocumentUpload ──▶ size check → status ready → promote_project_document() (current)
                                      → prune versions beyond 5

Runner (every 60 s, and right after each docker_local deploy)
   GET /api/runner/deployments/{id}/documents ──▶ manifest: current + public + unexpired,
                                                  each with a 10-minute signed URL
   download → verify size + SHA-256 → PutObject into its object store (RustFS, S3 API)
   remove objects no longer in the manifest
   write nginx snippet /etc/nginx/deployx.d/documents.conf → /files/* → store bucket

Visitor ── https://…trycloudflare.com/files/x.pdf ──▶ cloudflared ──▶ nginx proxy ──▶ object store
```

## Pieces

| Where | What |
|---|---|
| `supabase/migrations/…030_project_documents.sql` | `project_documents` table (path, version, is_current, sha256, size, visibility, expires_at), RLS (members read, developers write), `promote_project_document()` atomic swap, private `project-documents` bucket (25 MB limit) + storage RLS |
| `apps/web/…/documents/actions.ts` | upload (presigned PUT), finalize, delete, restore version, visibility, signed download |
| `apps/web/src/components/projects/documents-section.tsx` | Documents tab on the project page |
| `apps/web/src/lib/cron/expire-documents.ts` | lifecycle in the platform tick: expired paths removed, abandoned uploads (24 h) removed |
| `apps/web/src/app/api/runner/deployments/[deploymentId]/documents` | runner manifest (org-scoped) |
| `apps/runner/src/documents/object-store.ts` | the runner's S3-compatible store (`rustfs/rustfs:1.0.3`) |
| `apps/runner/src/documents/document-sync.ts` | sync plan, verified download, nginx snippet |
| `apps/runner/src/documents/document-syncer.ts` | background loop |

## Object store on the runner

- One container, `deployx-objectstore`, on `deployx-net`. The S3 API is bound to
  `127.0.0.1:19000` only, so only the runner itself can write. Project proxies read
  over the Docker network.
- Four volumes (`deployx-objectstore-d1…d4`). RustFS erasure-codes each object across
  them, as data and parity shards: every object has a shard on each drive. The drives
  are volumes on one physical disk, so this shows how erasure coding works and survives
  losing a volume. It can't survive that disk failing; RustFS needs
  `RUSTFS_UNSAFE_BYPASS_DISK_CHECK` to accept this layout.
- Per-project bucket `docs-<slug>`:
  - versioning on
  - anonymous **GetObject only** (no listing)
  - lifecycle rule expiring noncurrent versions after 7 days
- Credentials are generated once into `~/.deployx/objectstore.json` (mode 600). If they
  change, the runner restarts the store with the new ones, and the data volumes are kept.
- No documents means no object store: a project without documents never pulls the image.
- Swap the backend with `DEPLOYX_OBJECT_STORE_IMAGE` (any S3-compatible server that
  reads `RUSTFS_*` or `MINIO_ROOT_*` env).

## nginx

Deployers write `conf.d/default.conf` on every cutover; feature snippets live in
`/etc/nginx/deployx.d/*.conf`, included inside the `server` block, so they survive.
`/files/` is read-only (`limit_except GET HEAD`). It sends `X-Content-Type-Options: nosniff`
and `Cache-Control: public, max-age=300`, and missing files return 404. The store's host
name is resolved at request time, so a proxy without a store still starts.

Proxies created before this feature have no include line; their next deploy adds it.

## Verified live (Docker Desktop)

Proxy + app + store on `deployx-net`:
- GET of an uploaded PDF returns 200 with `application/pdf` and nosniff
- missing files and `/files/` itself return 404
- PUT is refused and the object stays unchanged
- the document is still served after a blue-green config rewrite
- delete creates a delete marker and keeps the old version
- versioning, policy and lifecycle read back from the API
- every object has a shard on all 4 drives
- a restart keeps data and leaks no anonymous volumes

## Course mapping

- **Unit 2 (object storage):**
  - object storage, buckets and keys
  - RAID, parity and mirroring, through erasure coding across drives
  - file vs object access methods
- **Lab 2 (S3):**
  - S3 API, versioning, lifecycle rules and bucket policies
  - presigned upload and download URLs
  - serving static content from a bucket
- **Unit 5 (security):**
  - least privilege (store on loopback; public = GetObject only)
  - integrity (SHA-256 checked before publishing)
  - RLS
- **Lab 7 (caching):** `Cache-Control` at the edge proxy (the cache tier itself is in doc 24)
