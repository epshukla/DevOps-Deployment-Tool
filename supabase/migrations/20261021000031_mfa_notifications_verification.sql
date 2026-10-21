-- ============================================================================
-- 031: MFA policy, notification webhooks, document verification
--
-- 1. organizations.require_mfa: when true, Owners and Admins must have a
--    verified TOTP factor (Supabase Auth MFA) and sign in at AAL2. Users who
--    enrolled a factor always have to complete it, whatever this flag says.
-- 2. organizations.notify_webhook_url: notifications are also POSTed here
--    (Slack / Discord / any JSON webhook) — fan-out, like SNS → subscribers.
-- 3. project_documents.verified_*: written by the `verify-document` Supabase
--    Edge Function after it re-hashes an uploaded object (serverless, event
--    driven via a Database Webhook).
--
-- Idempotent: safe to run more than once.
-- ============================================================================

alter table public.organizations
  add column if not exists require_mfa boolean not null default false,
  add column if not exists notify_webhook_url text
    check (notify_webhook_url is null or notify_webhook_url ~ '^https://');

alter table public.project_documents
  add column if not exists verified_at timestamptz,
  add column if not exists verification text
    check (verification is null or verification in ('ok', 'mismatch', 'missing'));
