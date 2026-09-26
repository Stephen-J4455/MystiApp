BEGIN;

-- ===========================================================================
-- Reconcile auth roles into public.user_profiles
-- ===========================================================================
-- Since 20260926_006 every role-gating edge function resolves role and
-- ownership from `public.user_profiles` instead of `auth.users`
-- metadata, because `user_metadata` is writable by the user themselves via
-- `supabase.auth.updateUser`.
--
-- That change is only safe if `user_profiles` actually reflects reality. It
-- currently does not: `handle_new_user()` populates it on auth-user INSERT, but
-- it was never backfilled, and `admin-users` was previously writing the
-- ILLEGAL role value "normal_user" into it (which the CHECK constraint on
-- `user_profiles.role` rejects), so every demotion silently failed to persist.
--
-- Consequences before this migration:
--   - accounts created before the trigger existed have NO profile row and
--     resolve to `sub_agent`, including real admins
--   - a user the admin demoted may still have the old role in their profile
--
-- This backfills every auth user into `user_profiles`, preferring
-- `app_metadata` (service-role-only, trustworthy) over `user_metadata`
-- (self-writable, so only a hint) and defaulting to `sub_agent` (fail
-- closed, matching `resolveIdentity`).
--
-- It is deliberately conservative: it does NOT delete or demote anyone. It
-- only creates or corrects the row so the authoritative store is populated.

-- ---------------------------------------------------------------------------
-- 1. Ensure every auth user has a profile row
-- ---------------------------------------------------------------------------
-- `role` values are constrained to admin | super_agent | admin's default of
-- sub_agent. "normal_user" is intentionally mapped to sub_agent: it is not a
-- legal CHECK value, and sub_agent is the least-privileged role that is.
-- `app_metadata` is consulted first because the user cannot write it.
INSERT INTO public.user_profiles (
  id, role, super_agent_id, email, full_name, business_name, created_at, updated_at
)
SELECT
  u.id,
  -- COALESCE order matters: app_metadata (trustworthy) beats user_metadata
  -- (self-writable) beats the fail-closed default.
  COALESCE(
    CASE lower(btrim(COALESCE(u.raw_app_meta_data ->> 'role', '')))
      WHEN 'admin' THEN 'admin'
      WHEN 'superagent' THEN 'super_agent'
      WHEN 'super_agent' THEN 'super_agent'
      WHEN 'agent' THEN 'sub_agent'
      WHEN 'sub_agent' THEN 'sub_agent'
    END,
    CASE lower(btrim(COALESCE(u.raw_user_meta_data ->> 'role', '')))
      WHEN 'admin' THEN 'admin'
      WHEN 'superagent' THEN 'super_agent'
      WHEN 'super_agent' THEN 'super_agent'
      WHEN 'agent' THEN 'sub_agent'
      WHEN 'sub_agent' THEN 'sub_agent'
    END,
    'sub_agent'
  ),
  COALESCE(
    NULLIF(btrim(COALESCE(u.raw_app_meta_data ->> 'super_agent_id', '')), ''),
    NULLIF(btrim(COALESCE(u.raw_user_meta_data ->> 'super_agent_id', '')), ''),
    NULLIF(btrim(COALESCE(u.raw_user_meta_data ->> 'superAgentId', '')), ''),
    NULLIF(btrim(COALESCE(u.raw_app_meta_data ->> 'superAgentId', '')), '')
  )::uuid,
  u.email,
  COALESCE(
    NULLIF(btrim(COALESCE(u.raw_user_meta_data ->> 'full_name', '')), ''),
    NULLIF(btrim(COALESCE(u.raw_user_meta_data ->> 'name', '')), '')
  ),
  NULLIF(btrim(COALESCE(u.raw_user_meta_data ->> 'business_name', '')), ''),
  u.created_at,
  now()
FROM auth.users u
ON CONFLICT (id) DO UPDATE
SET
  -- Only reconcile the fields the resolver depends on. email/full_name/
  -- business_name are refreshed too so the profile does not drift, but the
  -- authoritative role and ownership are what this migration exists to fix.
  role = EXCLUDED.role,
  super_agent_id = EXCLUDED.super_agent_id,
  email = COALESCE(EXCLUDED.email, public.user_profiles.email),
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. Report drift for human review
-- ---------------------------------------------------------------------------
-- Any row where the profile and the auth metadata disagree. After step 1 these
-- should be empty, but the table is kept so a future divergence is visible
-- rather than silently changing someone's access.
CREATE TABLE IF NOT EXISTS public.user_profile_drift_report (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  profile_role text,
  metadata_role text,
  profile_super_agent_id uuid,
  metadata_super_agent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_profile_drift_report IS
  'Users whose public.user_profiles row disagrees with their auth metadata. Normally empty; investigate any row, because authorization reads the profile.';

ALTER TABLE public.user_profile_drift_report ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_profile_drift_report_admin_read
  ON public.user_profile_drift_report;
CREATE POLICY user_profile_drift_report_admin_read
  ON public.user_profile_drift_report
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('Admin', 'admin')
  );

TRUNCATE public.user_profile_drift_report;

INSERT INTO public.user_profile_drift_report (
  user_id, email, profile_role, metadata_role,
  profile_super_agent_id, metadata_super_agent_id
)
SELECT
  p.id,
  p.email,
  p.role,
  lower(btrim(COALESCE(u.raw_app_meta_data ->> 'role', u.raw_user_meta_data ->> 'role', ''))),
  p.super_agent_id,
  NULLIF(
    btrim(COALESCE(
      u.raw_app_meta_data ->> 'super_agent_id',
      u.raw_user_meta_data ->> 'super_agent_id',
      u.raw_user_meta_data ->> 'superAgentId',
      ''
    )),
    ''
  )::uuid
FROM public.user_profiles p
JOIN auth.users u ON u.id = p.id
WHERE
  -- role disagreement, after normalizing the metadata spelling
  p.role IS DISTINCT FROM CASE lower(btrim(COALESCE(u.raw_app_meta_data ->> 'role', u.raw_user_meta_data ->> 'role', '')))
    WHEN 'admin' THEN 'admin'
    WHEN 'superagent' THEN 'super_agent'
    WHEN 'super_agent' THEN 'super_agent'
    WHEN 'agent' THEN 'sub_agent'
    WHEN 'sub_agent' THEN 'sub_agent'
    ELSE 'sub_agent'
  END
  -- ownership disagreement
  OR p.super_agent_id IS DISTINCT FROM NULLIF(
       btrim(COALESCE(
         u.raw_app_meta_data ->> 'super_agent_id',
         u.raw_user_meta_data ->> 'super_agent_id',
         u.raw_user_meta_data ->> 'superAgentId',
         ''
       )),
       ''
     )::uuid;

-- ---------------------------------------------------------------------------
-- Readable outcome
-- ---------------------------------------------------------------------------
--   -- Role distribution after the backfill (expect no surprises):
--   SELECT role, count(*) FROM public.user_profiles GROUP BY role ORDER BY role;
--
--   -- Sub-agents with no super agent assigned. These resolve to the platform
--   -- default AFA price and have no settlement chain, which may be intentional
--   -- or may be a missing assignment:
--   SELECT count(*) FROM public.user_profiles
--    WHERE role = 'sub_agent' AND super_agent_id IS NULL;
--
--   -- Any remaining drift (normally empty):
--   SELECT * FROM public.user_profile_drift_report;

COMMIT;
