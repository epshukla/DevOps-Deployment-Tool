-- ============================================================================
-- 027: blue_green_cutover healing event + settle stale "draining" deployments
--
-- 1. The runner records a blue_green_cutover event after every blue-green
--    switch and the API validator accepts it, but the enum never had the
--    value, so every insert failed with a 500.
-- 2. Until now nothing moved a replaced deployment past "draining". The API
--    now settles them when the replacement goes active; this stops the ones
--    already left behind (any project that has a newer active deployment).
--
-- Idempotent: safe to run more than once.
-- ============================================================================

alter type healing_event_type add value if not exists 'blue_green_cutover';

update public.deployments d
   set status = 'stopped',
       public_url = null,
       public_url_expires_at = null,
       updated_at = now()
 where d.status = 'draining'
   and exists (
     select 1 from public.deployments newer
      where newer.project_id = d.project_id
        and newer.status = 'active'
        and newer.created_at > d.created_at
   );
