-- ============================================================================
-- 029: close write paths that bypassed the role model
--
-- 1. org_invites: "invited_users_can_accept_own_invites" let an invitee
--    UPDATE any column of their own invite — including `role` — before
--    accepting it, so a viewer invite could be turned into admin. Accepting
--    and declining go through the SECURITY DEFINER RPCs (migration 025), so
--    the policy is no longer needed at all.
-- 2. build-artifacts storage: any org member (viewers too) could upload or
--    delete artifacts straight through the Storage API. Upload now needs
--    developer and delete admin, matching the app's server actions. The
--    runner uploads with the service role, which bypasses RLS.
-- 3. healing_events: only the runner API (service role) writes these, so
--    members no longer need an insert path; keep one for developers.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ── 1. Invites ──────────────────────────────────────────────────────────────

drop policy if exists "invited_users_can_accept_own_invites" on public.org_invites;

-- ── 2. Artifact storage ─────────────────────────────────────────────────────

drop policy if exists "org_members_can_upload_artifacts" on storage.objects;
drop policy if exists "developers_can_upload_artifacts" on storage.objects;
create policy "developers_can_upload_artifacts"
  on storage.objects for insert
  with check (
    bucket_id = 'build-artifacts'
    and auth.uid() is not null
    and exists (
      select 1 from public.org_memberships om
      where om.user_id = auth.uid()
        and (storage.foldername(name))[1] = om.org_id::text
        and om.role in ('developer', 'admin', 'owner')
    )
  );

drop policy if exists "org_members_can_delete_artifacts" on storage.objects;
drop policy if exists "admins_can_delete_artifacts" on storage.objects;
create policy "admins_can_delete_artifacts"
  on storage.objects for delete
  using (
    bucket_id = 'build-artifacts'
    and auth.uid() is not null
    and exists (
      select 1 from public.org_memberships om
      where om.user_id = auth.uid()
        and (storage.foldername(name))[1] = om.org_id::text
        and om.role in ('admin', 'owner')
    )
  );

-- ── 3. Healing events ───────────────────────────────────────────────────────

drop policy if exists "org_members_can_insert_healing_events" on public.healing_events;
drop policy if exists "developers_can_insert_healing_events" on public.healing_events;
create policy "developers_can_insert_healing_events"
  on public.healing_events for insert
  with check (
    exists (
      select 1 from public.deployments d
      join public.projects p on d.project_id = p.id
      where d.id = healing_events.deployment_id
        and has_org_role(p.org_id, 'developer')
    )
  );
