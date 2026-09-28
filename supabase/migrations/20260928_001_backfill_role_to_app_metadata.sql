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

-- ---------------------------------------------------------------------------
-- Verify: every admin should now resolve `is_mysti_admin()` to true.
-- Run as an AUTHENTICATED ADMIN SESSION, not as the service role - the service
-- role bypasses RLS, so testing it proves nothing.
-- ---------------------------------------------------------------------------
--   SELECT public.is_mysti_admin() AS should_be_true;
--
-- Confirm no role is left stranded in user_metadata only:
--
--   SELECT count(*) AS still_missing
--     FROM auth.users
--    WHERE COALESCE(raw_user_meta_data ->> 'role', '') <> ''
--      AND COALESCE(raw_app_meta_data ->> 'role', '') = '';
--
-- Expect 0. A non-zero result means an account has a role that no RLS policy
-- can see - investigate it before closing this out.
-- ---------------------------------------------------------------------------

COMMIT;
