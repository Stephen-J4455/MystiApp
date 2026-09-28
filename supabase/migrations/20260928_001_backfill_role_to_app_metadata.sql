BEGIN;

-- ===========================================================================
-- Backfill `app_metadata.role` from `user_metadata.role`
-- ===========================================================================
-- WHY
-- ---
-- RLS read policies key on `(auth.jwt() -> 'app_metadata' ->> 'role')` and
-- NOTHING else. They cannot use `user_metadata` because that store is writable
-- by the account itself via `supabase.auth.updateUser()`, so a policy built on
-- it is self-service privilege escalation. Migration 20260926_010
-- (`strip_user_metadata_rls.sql`) stripped those `user_metadata` legs on
-- purpose.
--
-- The consequence: `admin-users` `setUserRole` wrote the role ONLY to
-- `user_metadata`, so no account ever carried one in `app_metadata` and every
-- one of those policies evaluated to false.
--
-- The visible symptom was on the admin app's "Edge Logs" screen. It reads
-- `edge_function_logs` directly with the ANON key while signed in as an
-- `authenticated` user, so the read is filtered by RLS. RLS returning no rows
-- is HTTP 200 with `[]`, which the screen renders as "no activity" - the
-- silent-zero trap. `edge_function_logs_admin_read` is one of several
-- policies affected; the admin legs in 20260926_006 / _008 / _009 share it.
--
-- `setUserRole` now mirrors the role into both stores. This migration repairs
-- the accounts that already exist, which nothing else would ever fix: a
-- service-role `updateUserById` has no cross-device push, so a running client
-- is not told and an admin who was never re-assigned keeps the empty value.
--
-- IDEMPOTENT AND NON-DESTRUCTIVE
-- ------------------------------
-- Copies only roles already present in `raw_user_meta_data`, and only where
-- `app_metadata` has none. It never invents a role, and never overwrites an
-- `app_metadata` value that is already set - so running it twice is a no-op
-- and it cannot clobber a deliberate admin-side change.
--
-- Idempotency caveat: a SECOND run will not repair an account that was left
-- deliberately empty, which is the correct behaviour - "no role" is a
-- meaningful state (a normal user), and re-deriving it from user_metadata
-- would resurrect a role the admin had intentionally cleared.
-- ===========================================================================

-- Admin and Super Agent accounts: copy the role across.
--
-- `super_agent_id` is mirrored too, because the same policies and the
-- `super-agent-user-management` ownership checks read either store and the
-- admin app's user list displays the owner.
UPDATE auth.users
   SET raw_app_meta_data = jsonb_set(
         COALESCE(raw_app_meta_data, '{}'::jsonb),
         '{role}',
         to_jsonb(raw_user_meta_data ->> 'role'),
         true
       )
 WHERE COALESCE(raw_user_meta_data ->> 'role', '') <> ''
   AND COALESCE(raw_app_meta_data ->> 'role', '') = '';

-- Mirror the Super Agent assignment. Scoped to the rows that are actually
-- Super Agents, so a sub-agent's `super_agent_id` is not promoted into a
-- store that gates writes.
UPDATE auth.users
   SET raw_app_meta_data = jsonb_set(
         COALESCE(raw_app_meta_data, '{}'::jsonb),
         '{super_agent_id}',
         to_jsonb(raw_user_meta_data ->> 'super_agent_id'),
         true
       )
 WHERE lower(COALESCE(raw_user_meta_data ->> 'role', ''))
         IN ('super_agent', 'superagent')
   AND COALESCE(raw_user_meta_data ->> 'super_agent_id', '') <> ''
   AND COALESCE(raw_app_meta_data ->> 'super_agent_id', '') = '';

-- ===========================================================================
-- PART 2 - repair `user_profiles.role` for demoted accounts
-- ===========================================================================
-- WHY
-- ---
-- `setUserRole` wrote `sub_agent` into `user_profiles.role` whenever the admin
-- demoted anyone to a normal user, on the stated grounds that "normal_user" was
-- not a legal CHECK value. Migration 20260925_004 HAD ALREADY WIDENED the
-- constraint to include 'normal_user', so that rationale expired - but the
-- mapping stayed.
--
-- `user_profiles.role` is the store every edge function's `resolveIdentity`
-- reads. A demoted Super Agent was therefore still recorded as `sub_agent`,
-- which is NOT "no role" - so they retained sub-agent behaviour (ownership
-- checks, assignment-derived affordances) after the admin had removed it.
-- Migration 20260926_009 has the same expired premise: it maps an absent role
-- to 'sub_agent' rather than 'normal_user'.
--
-- This statement maps ONLY rows whose auth metadata now says "no role at all",
-- which is the admin app's own representation of a normal user (see
-- `ROLE_LADDER` in UserManagementScreen.js: "normal_user" is represented by
-- having no role metadata). It is deliberately narrow - it never promotes
-- anyone and never touches an account that still carries a role.
--
-- Ordering note: this runs AFTER part 1, so `raw_app_meta_data` has already
-- been repaired and is authoritative when the WHERE clause below reads it.
-- Without that ordering a role stranded in `user_metadata` alone would make
-- the second predicate false and this statement would skip the account.
-- ===========================================================================

UPDATE public.user_profiles p
   SET role = 'normal_user',
       updated_at = now()
  FROM auth.users u
 WHERE p.id = u.id
   -- auth metadata now says "no role" in BOTH stores...
   AND COALESCE(btrim(COALESCE(u.raw_app_meta_data ->> 'role', '')), '') = ''
   AND COALESCE(btrim(COALESCE(u.raw_user_meta_data ->> 'role', '')), '') = ''
   -- ...but the profile still claims an agent role from the stale mapping.
   AND p.role IN ('sub_agent', 'normal_user');

-- ---------------------------------------------------------------------------
-- PART 3 - verify
-- ---------------------------------------------------------------------------
-- Role distribution after the backfill. Expect admins and super agents to
-- appear; the bulk will be normal_user and sub_agent.
--
--   SELECT role, count(*) FROM public.user_profiles GROUP BY role ORDER BY role;
--
-- No role stranded in user_metadata only (expect 0):
--
--   SELECT count(*) AS still_missing
--     FROM auth.users
--    WHERE COALESCE(raw_user_meta_data ->> 'role', '') <> ''
--      AND COALESCE(raw_app_meta_data ->> 'role', '') = '';
--
-- Every admin should resolve `is_mysti_admin()` to true. Run this as an
-- AUTHENTICATED ADMIN SESSION, not as the service role - the service role
-- bypasses RLS, so testing it proves nothing:
--
--   SELECT public.is_mysti_admin() AS should_be_true;
-- ---------------------------------------------------------------------------

COMMIT;
