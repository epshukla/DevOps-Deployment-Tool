-- ============================================================================
-- 030: project documents (object storage + metadata)
--
-- Users upload documents to a project; they are served on the project's
-- deployment URL under /files/<path> (public) or through short-lived signed
-- links from the dashboard (private).
--
--   * Original bytes live in the Supabase Storage bucket `project-documents`
--     at {org_id}/{project_id}/{document_id}. Browsers upload straight to it
--     with a signed upload URL (presigned PUT), never through the app server.
--   * project_documents holds the reference: path, checksum, size, version,
--     visibility and lifecycle (expiry). Every upload of a path is a new
--     version; exactly one version per path is current.
--   * Runners mirror the current public documents into their own object store
--     (MinIO) and serve them through the project's nginx proxy, so they appear
--     on the same Cloudflare tunnel URL as the site.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

create table if not exists public.project_documents (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  org_id        uuid not null references public.organizations (id) on delete cascade,
  path          text not null check (char_length(path) between 1 and 200),
  version       integer not null check (version > 0),
  is_current    boolean not null default false,
  status        text not null default 'pending' check (status in ('pending', 'ready')),
  storage_key   text not null unique,
  content_type  text not null default 'application/octet-stream',
  size_bytes    bigint not null check (size_bytes > 0),
  sha256        text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  visibility    text not null default 'public' check (visibility in ('public', 'private')),
  expires_at    timestamptz,
  uploaded_by   uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (project_id, path, version)
);

-- One current version per path
create unique index if not exists idx_project_documents_current
  on public.project_documents (project_id, path)
  where is_current;

create index if not exists idx_project_documents_project
  on public.project_documents (project_id, path, version desc);

create index if not exists idx_project_documents_expires
  on public.project_documents (expires_at)
  where expires_at is not null;

alter table public.project_documents enable row level security;

drop policy if exists "org_members_can_read_project_documents" on public.project_documents;
create policy "org_members_can_read_project_documents"
  on public.project_documents for select
  using (is_org_member(org_id));

drop policy if exists "developers_can_insert_project_documents" on public.project_documents;
create policy "developers_can_insert_project_documents"
  on public.project_documents for insert
  with check (
    has_org_role(org_id, 'developer')
    and exists (
      select 1 from public.projects p
      where p.id = project_documents.project_id and p.org_id = project_documents.org_id
    )
  );

drop policy if exists "developers_can_update_project_documents" on public.project_documents;
create policy "developers_can_update_project_documents"
  on public.project_documents for update
  using (has_org_role(org_id, 'developer'))
  with check (has_org_role(org_id, 'developer'));

drop policy if exists "developers_can_delete_project_documents" on public.project_documents;
create policy "developers_can_delete_project_documents"
  on public.project_documents for delete
  using (has_org_role(org_id, 'developer'));

-- ── Make a version the current one (atomic swap) ────────────────────────────
-- security invoker: runs with the caller's RLS, so only developers can swap.
create or replace function public.promote_project_document(p_document_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project uuid;
  v_path    text;
begin
  select project_id, path into v_project, v_path
  from public.project_documents
  where id = p_document_id and status = 'ready';

  if v_project is null then
    raise exception 'document % not found or not ready', p_document_id;
  end if;

  update public.project_documents
     set is_current = false
   where project_id = v_project and path = v_path and is_current and id <> p_document_id;

  update public.project_documents
     set is_current = true
   where id = p_document_id;
end;
$$;

-- ── Storage bucket ──────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-documents', 'project-documents', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Object path: {org_id}/{project_id}/{document_id}
drop policy if exists "org_members_can_read_documents" on storage.objects;
create policy "org_members_can_read_documents"
  on storage.objects for select
  using (
    bucket_id = 'project-documents'
    and auth.uid() is not null
    and exists (
      select 1 from public.org_memberships om
      where om.user_id = auth.uid()
        and (storage.foldername(name))[1] = om.org_id::text
    )
  );

drop policy if exists "developers_can_upload_documents" on storage.objects;
create policy "developers_can_upload_documents"
  on storage.objects for insert
  with check (
    bucket_id = 'project-documents'
    and auth.uid() is not null
    and exists (
      select 1 from public.org_memberships om
      where om.user_id = auth.uid()
        and (storage.foldername(name))[1] = om.org_id::text
        and om.role in ('developer', 'admin', 'owner')
    )
  );

drop policy if exists "developers_can_delete_documents" on storage.objects;
create policy "developers_can_delete_documents"
  on storage.objects for delete
  using (
    bucket_id = 'project-documents'
    and auth.uid() is not null
    and exists (
      select 1 from public.org_memberships om
      where om.user_id = auth.uid()
        and (storage.foldername(name))[1] = om.org_id::text
        and om.role in ('developer', 'admin', 'owner')
    )
  );
