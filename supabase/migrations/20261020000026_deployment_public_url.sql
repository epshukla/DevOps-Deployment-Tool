-- ============================================================================
-- 026: Temporary public URLs for deployments
--
-- docker_local deployments can be exposed through a Cloudflare quick tunnel
-- (https://<words>.trycloudflare.com). The runner reports the URL and when it
-- stops working; the /api/cron/tick job clears it after expiry.
-- ============================================================================

alter table public.deployments
  add column if not exists public_url text,
  add column if not exists public_url_expires_at timestamptz;

alter table public.deployments
  drop constraint if exists deployments_public_url_https;
alter table public.deployments
  add constraint deployments_public_url_https
  check (public_url is null or public_url like 'https://%');
