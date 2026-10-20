-- ============================================================================
-- 028: pick a runner for a run + runner resource metrics
--
-- 1. pipeline_runs.target_runner_id: when set, only that runner may claim the
--    run; null keeps the old behaviour (any online runner in the org).
--    pipeline_runs.runner_id still records who actually ran it.
-- 2. Runners report host + Docker usage with their heartbeat. The latest
--    snapshot lives on runner_registrations (cheap list view); a sampled
--    history goes to runner_metrics for charts. The platform tick prunes
--    history older than 24 hours.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ── 1. Runner targeting ─────────────────────────────────────────────────────

alter table public.pipeline_runs
  add column if not exists target_runner_id uuid
    references public.runner_registrations (id) on delete set null;

create index if not exists idx_pipeline_runs_queued_target
  on public.pipeline_runs (target_runner_id)
  where status = 'queued';

-- ── 2. Runner metrics ───────────────────────────────────────────────────────

alter table public.runner_registrations
  add column if not exists metrics jsonb,
  add column if not exists metrics_at timestamptz;

create table if not exists public.runner_metrics (
  id                  bigint generated always as identity primary key,
  runner_id           uuid not null references public.runner_registrations (id) on delete cascade,
  org_id              uuid not null references public.organizations (id) on delete cascade,
  recorded_at         timestamptz not null default now(),
  cpu_percent         real,
  load_1m             real,
  memory_used_mb      integer,
  memory_total_mb     integer,
  disk_used_gb        real,
  disk_total_gb       real,
  containers_running  integer,
  docker_cpu_percent  real,
  docker_memory_mb    integer
);

create index if not exists idx_runner_metrics_runner_time
  on public.runner_metrics (runner_id, recorded_at desc);
create index if not exists idx_runner_metrics_recorded
  on public.runner_metrics (recorded_at);

alter table public.runner_metrics enable row level security;

-- Written only by the runner API (service role); members can read their org's
drop policy if exists "org_members_can_read_runner_metrics" on public.runner_metrics;
create policy "org_members_can_read_runner_metrics"
  on public.runner_metrics for select
  using (is_org_member(org_id));
