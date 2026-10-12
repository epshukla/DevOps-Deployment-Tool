-- ============================================================================
-- 024: Realtime for deployment pages + a once-a-minute platform tick
--
-- 1. Publish the deployment-related tables to supabase_realtime so the
--    deployment detail page and notification bell update live.
-- 2. Schedule /api/cron/tick every minute with pg_cron + pg_net. This works on
--    every Supabase and Vercel plan (Vercel Hobby crons are limited to daily).
--    The URL and bearer secret are read from Supabase Vault at run time, so
--    no secret lives in this migration. Until both vault secrets exist the
--    job is a no-op:
--
--      select vault.create_secret('https://<app>/api/cron/tick', 'deployx_tick_url');
--      select vault.create_secret('<same value as CRON_SECRET>', 'deployx_cron_secret');
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ── 1. Realtime publication ─────────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array[
    'pipeline_runs',
    'task_runs',
    'step_runs',
    'run_logs',
    'deployments',
    'deployment_revisions',
    'health_check_results',
    'healing_events',
    'deployment_approvals',
    'approval_votes',
    'notifications'
  ]
  loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = t)
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime'
                         and schemaname = 'public' and tablename = t)
    then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- ── 2. Platform tick ────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Fire-and-forget HTTP call to the tick endpoint. SECURITY DEFINER so the
-- cron job can read the vault; search_path pinned to avoid hijacking.
create or replace function public.deployx_cron_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tick_url text;
  cron_secret text;
begin
  select decrypted_secret into tick_url
    from vault.decrypted_secrets where name = 'deployx_tick_url';
  select decrypted_secret into cron_secret
    from vault.decrypted_secrets where name = 'deployx_cron_secret';

  if tick_url is null or cron_secret is null then
    return; -- not configured yet
  end if;

  perform net.http_post(
    url := tick_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || cron_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function public.deployx_cron_tick() from public, anon, authenticated;

-- (Re)schedule by name so re-running the migration doesn't duplicate jobs
select cron.unschedule(jobid) from cron.job where jobname = 'deployx-tick';
select cron.schedule('deployx-tick', '* * * * *', 'select public.deployx_cron_tick()');
