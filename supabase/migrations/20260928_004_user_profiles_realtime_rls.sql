BEGIN;

-- ===========================================================================
-- Make `user_profiles` readable by its owner, and subscribable in realtime
-- ===========================================================================
-- WHY
-- ---
-- Edge functions read role and ownership from `public.user_profiles` via
-- `resolveIdentity` (see identity-authorization-source.md). The clients do
-- NOT. Both apps read the role out of the JWT, which only changes when
-- supabase-js issues a new token, and supabase-js has no cross-device push
-- for auth metadata - a service-role `updateUserById` never reaches a running
-- client.
--
-- `MystiApp/App.js` worked around this by calling `refreshSession()` when the
-- app returns to the foreground. That is a NUDGE, not an update: the user has
-- to background and foreground the app, so a rank/demote can sit invisible
-- for as long as they keep the app open.
--
-- This migration puts the AUTHORITATIVE store on a realtime channel so the
-- client learns about the change the moment it is written.
--
-- SECURITY FINDING FIXED HERE
-- ---------------------------
-- `20260920_001` created this table with NO `ENABLE ROW LEVEL SECURITY`, and
-- no later migration turned it on. PostgREST therefore exposed EVERY profile
-- row - role, full_name, email, phone, and the agent -> super agent
-- ownership graph - to the ANON key, to anyone with the public URL and the
-- publishable anon key that ships inside the app bundle. This is the table
-- every authorization decision is derived from, so it is the most sensitive
-- table in the project. Enabling RLS is what makes the realtime policies
-- below meaningful; without this step a realtime subscription on it would be
-- a way to EXFILTRATE the table, not just read one row.
--
-- The two policies below are deliberately narrow:
--   * a user may read ONLY their own profile - that is all the client needs
--     to detect "my role changed";
--   * an admin may read all of them, for the User Management screen.
--
-- Authorization for EDGE FUNCTIONS is unaffected: they use the service-role
-- client, which bypasses RLS by design.
--
-- The admin policy keys on `app_metadata` ONLY. A policy built on
-- `user_metadata` would be self-service privilege escalation, because the
-- account can rewrite that store itself with `supabase.auth.updateUser()` -
-- see 20260926_010 for the same argument applied to `is_mysti_admin()`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Turn RLS on
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_profiles
  ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY does NOT support IF NOT EXISTS, so drop first. Re-running this
-- migration is then a no-op rather than an error.
DROP POLICY IF EXISTS user_profiles_select_own ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_select_admin ON public.user_profiles;

-- ---------------------------------------------------------------------------
-- 2. Owner reads their own row
-- ---------------------------------------------------------------------------
-- This is what the main app subscribes on: it watches exactly its own id and
-- re-reads its role when the row changes. No other row is reachable.
CREATE POLICY user_profiles_select_own
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Admins read all of them
-- ---------------------------------------------------------------------------
-- Needed for the User Management screen's realtime refresh. `app_metadata`
-- only - never `user_metadata`, which the account can write itself.
CREATE POLICY user_profiles_select_admin
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (
    lower(btrim(COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '')))
    IN ('admin', 'administrator', 'superadmin', 'super_admin')
  );

-- ---------------------------------------------------------------------------
-- 4. Put the table on the realtime publication
-- ---------------------------------------------------------------------------
-- Postgres raises "relation is already member of publication" if it is added
-- twice, so guard on pg_publication_tables. Without this the subscription
-- connects cleanly and then silently receives nothing - a subscription that
-- looks alive and is not, which is the same silent-zero trap as the Edge Logs
-- screen.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'user_profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_profiles;
  END IF;
END
$$;

-- The table is keyed on `id`, so an UPDATE already carries the full new row
-- and the client does not need the old one. Stated explicitly rather than
-- left to default, because `REPLICA IDENTITY FULL` would replicate the whole
-- row twice on every change.
ALTER TABLE public.user_profiles
  REPLICA IDENTITY DEFAULT;

-- ---------------------------------------------------------------------------
-- 5. Verify
-- ---------------------------------------------------------------------------
-- The policies landed, and the table is on the publication:
--
--   SELECT policyname, cmd, roles FROM pg_policies
--    WHERE tablename = 'user_profiles';
--
--   SELECT pubname, schemaname, tablename FROM pg_publication_tables
--    WHERE tablename = 'user_profiles';
--
-- RLS is on, so an anon request now sees nothing:
--
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'user_profiles';
--
-- The ownership graph is still only ever read through the service role, so no
-- edge function needs changing - `resolveIdentity` is unaffected.
-- ---------------------------------------------------------------------------

COMMIT;
