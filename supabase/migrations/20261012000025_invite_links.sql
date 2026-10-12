-- ============================================================================
-- Shareable organization invite links
--
-- 1. org_invites.token    — random single-use bearer credential (48 hex chars)
--    org_invites.accepted_by — who redeemed the invite
-- 2. get_invite_preview(token)          — anon + authenticated, masked email
-- 3. accept_org_invite(token)           — authenticated, creates membership
-- 4. decline_org_invite(token)          — authenticated, deletes the invite
-- 5. accept/decline_org_invite_by_id(id) — in-app banner path (no token);
--    caller's auth email must match the invite email
--
-- All mutating functions are SECURITY DEFINER because org_memberships INSERT
-- is restricted by RLS to org admins: an invitee has no membership yet, so
-- the old client-side insert could never succeed.
-- ============================================================================

-- ── Columns ─────────────────────────────────────────────────────────────────

alter table public.org_invites
  add column if not exists token text;

alter table public.org_invites
  alter column token set default encode(extensions.gen_random_bytes(24), 'hex');

-- Backfill rows created before this migration (each gets its own token)
update public.org_invites
   set token = encode(extensions.gen_random_bytes(24), 'hex')
 where token is null;

alter table public.org_invites
  alter column token set not null;

create unique index if not exists org_invites_token_key
  on public.org_invites (token);

alter table public.org_invites
  add column if not exists accepted_by uuid references auth.users (id) on delete set null;

-- ── Helpers (internal, not callable through the API) ───────────────────────

-- th•••@gmail.com — enough for the invitee to recognise their address,
-- not enough for someone holding a leaked link to learn it.
create or replace function public.mask_invite_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then '•••'
    else left(split_part(p_email, '@', 1),
              case when length(split_part(p_email, '@', 1)) <= 2 then 1 else 2 end)
         || '•••@'
         || substring(p_email from position('@' in p_email) + 1)
  end;
$$;

-- Redeem an invite for auth.uid(). Locks the row so two concurrent accepts
-- cannot both succeed. Callers are responsible for authorising the caller
-- (token possession or email match) before calling this.
create or replace function public.redeem_org_invite_internal(
  p_invite_id uuid,
  p_via text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite record;
  v_role public.org_memberships.role%type;
  v_inserted integer := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select i.id, i.org_id, i.role, i.accepted_at, i.expires_at
    into v_invite
    from public.org_invites i
   where i.id = p_invite_id
     for update;

  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite_already_accepted' using errcode = 'P0001';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;
  -- Defence in depth: ownership is never granted through an invite
  if v_invite.role::text not in ('viewer', 'developer', 'admin') then
    raise exception 'invite_invalid_role' using errcode = 'P0001';
  end if;

  -- PL/pgSQL assignment coerces even if invite.role and membership.role
  -- are declared with different (text / enum) types.
  v_role := v_invite.role;

  -- Already a member: keep their current role (never downgrade an admin
  -- or owner who clicks an old viewer link), just consume the invite.
  if not exists (
    select 1 from public.org_memberships m
     where m.org_id = v_invite.org_id and m.user_id = v_uid
  ) then
    insert into public.org_memberships (org_id, user_id, role)
    values (v_invite.org_id, v_uid, v_role)
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
  end if;

  update public.org_invites
     set accepted_at = now(),
         accepted_by = v_uid
   where id = v_invite.id;

  if v_inserted > 0 then
    insert into public.audit_events
      (org_id, user_id, action, resource_type, resource_id, details)
    values
      (v_invite.org_id, v_uid, 'create', 'membership', v_uid,
       jsonb_build_object(
         'via', p_via,
         'role', v_invite.role::text,
         'invite_id', v_invite.id
       ));
  end if;

  return v_invite.org_id;
end;
$$;

-- Delete a pending invite on behalf of the invitee and audit it.
create or replace function public.decline_org_invite_internal(
  p_invite_id uuid,
  p_via text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select i.id, i.org_id, i.accepted_at
    into v_invite
    from public.org_invites i
   where i.id = p_invite_id
     for update;

  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite_already_accepted' using errcode = 'P0001';
  end if;

  delete from public.org_invites where id = v_invite.id;

  insert into public.audit_events
    (org_id, user_id, action, resource_type, resource_id, details)
  values
    (v_invite.org_id, v_uid, 'delete', 'invite', v_invite.id,
     jsonb_build_object('via', p_via, 'declined', true));
end;
$$;

-- Resolve a token to an invite id, or raise invite_not_found.
create or replace function public.invite_id_for_token_internal(p_token text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_token is null or length(p_token) not between 16 and 128 then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;

  select i.id into v_id from public.org_invites i where i.token = p_token;
  if v_id is null then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

-- Resolve an invite id addressed to the caller's auth email, or raise.
create or replace function public.invite_id_for_caller_internal(p_invite_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_email text;
  v_invite_email text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select lower(u.email) into v_caller_email
    from auth.users u where u.id = auth.uid();

  select lower(i.email::text) into v_invite_email
    from public.org_invites i where i.id = p_invite_id;

  if v_invite_email is null then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_caller_email is null or v_caller_email <> v_invite_email then
    raise exception 'invite_email_mismatch' using errcode = '42501';
  end if;
  return p_invite_id;
end;
$$;

-- ── Public API ──────────────────────────────────────────────────────────────

-- What the /invite/<token> landing page shows. Safe for anon: it only
-- answers for a caller who already holds the 192-bit token, and masks the
-- email so a forwarded/leaked link does not reveal the invitee's address.
create or replace function public.get_invite_preview(p_token text)
returns table (
  org_name text,
  role text,
  email text,
  expires_at timestamptz,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name::text,
         i.role::text,
         public.mask_invite_email(i.email::text),
         i.expires_at::timestamptz,
         case
           when i.accepted_at is not null then 'accepted'
           when i.expires_at <= now() then 'expired'
           else 'pending'
         end
    from public.org_invites i
    join public.organizations o on o.id = i.org_id
   where p_token is not null
     and length(p_token) between 16 and 128
     and i.token = p_token
   limit 1;
$$;

-- SECURITY MODEL: the token is a single-use bearer credential. ANY signed-in
-- user (any GitHub account) holding a valid, unexpired, unaccepted link may
-- accept it — the invite email is NOT required to match the caller, because
-- GitHub's primary email often differs from the address the admin typed.
-- Admins must treat links like passwords: share them privately, cancel any
-- that leak. Links expire (org_invites.expires_at) and work exactly once.
create or replace function public.accept_org_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return public.redeem_org_invite_internal(
    public.invite_id_for_token_internal(p_token),
    'invite_link'
  );
end;
$$;

-- Same bearer model as accept_org_invite: holding the link lets you discard it.
create or replace function public.decline_org_invite(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  perform public.decline_org_invite_internal(
    public.invite_id_for_token_internal(p_token),
    'invite_link'
  );
end;
$$;

-- In-app banner path: no token is involved, so the caller is authorised by
-- their verified auth email matching the invite email instead.
create or replace function public.accept_org_invite_by_id(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.redeem_org_invite_internal(
    public.invite_id_for_caller_internal(p_invite_id),
    'invite_banner'
  );
end;
$$;

create or replace function public.decline_org_invite_by_id(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.decline_org_invite_internal(
    public.invite_id_for_caller_internal(p_invite_id),
    'invite_banner'
  );
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE on new public functions to anon/authenticated by
-- default, so revoke explicitly from every API role, then re-grant.

revoke all on function public.mask_invite_email(text) from public, anon, authenticated;
revoke all on function public.redeem_org_invite_internal(uuid, text) from public, anon, authenticated;
revoke all on function public.decline_org_invite_internal(uuid, text) from public, anon, authenticated;
revoke all on function public.invite_id_for_token_internal(text) from public, anon, authenticated;
revoke all on function public.invite_id_for_caller_internal(uuid) from public, anon, authenticated;

revoke all on function public.get_invite_preview(text) from public;
grant execute on function public.get_invite_preview(text) to anon, authenticated;

revoke all on function public.accept_org_invite(text) from public, anon;
grant execute on function public.accept_org_invite(text) to authenticated;

revoke all on function public.decline_org_invite(text) from public, anon;
grant execute on function public.decline_org_invite(text) to authenticated;

revoke all on function public.accept_org_invite_by_id(uuid) from public, anon;
grant execute on function public.accept_org_invite_by_id(uuid) to authenticated;

revoke all on function public.decline_org_invite_by_id(uuid) from public, anon;
grant execute on function public.decline_org_invite_by_id(uuid) to authenticated;
