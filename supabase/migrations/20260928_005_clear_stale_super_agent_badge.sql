BEGIN;

-- ===========================================================================
-- Clear Super Agent badges and ownership left on demoted accounts
-- ===========================================================================
-- WHY
-- ---
-- `setUserRole` builds the next metadata by copying the current one and then
-- `delete`-ing the keys that the new role cannot carry:
--
--     delete nextMetadata.super_agent_badge;
--     delete nextAppMetadata.super_agent_badge;
--     delete nextMetadata.super_agent_id;
--     delete nextAppMetadata.role;
--
-- That code is correct JavaScript and it does NOT WORK. GoTrue MERGES the
-- metadata object it is handed (JSON merge-patch semantics), so a key that is
-- merely ABSENT from the patch is never transmitted and the STORED value
-- survives untouched. `delete obj.key` removes the key from the JavaScript
-- object, which is indistinguishable from never having set it - so the delete
-- silently did nothing, and the old value stayed in `auth.users`.
--
-- THE OBSERVED SYMPTOM: an Enterprise Super Agent was demoted to a normal user
-- and kept logging in as "Super Agent - Enterprise". The role demotion itself
-- worked (both stores and `user_profiles` were updated), so the account was no
-- longer a super agent to any edge function - but the badge was still present
-- in `user_metadata` AND `app_metadata`, and the clients read it to decide what
-- to render. Five edge functions also gate Enterprise-only capabilities on
-- `app_metadata.super_agent_badge`.
--
-- WHY A DATA REPAIR IS NEEDED, NOT JUST THE CODE FIX
-- --------------------------------------------------
-- `admin-users` `setUserRole` is now fixed to send an explicit JSON `null`,
-- which merge-patch DOES transmit, and that removes the key. But that only
-- helps accounts that are demoted again FROM NOW ON. Every account already
-- demoted while the broken delete was in place still carries a stale badge, and
-- nothing in the schema will ever clear it - the `handle_new_user` trigger
-- only fires on INSERT, and no migration backfilled or scrubbed these keys.
--
-- A stale badge is not cosmetic. It is the input to the Enterprise gates in
-- `paystack-subaccount`, `super-agent-offers`, `super-agent-tier-management`,
-- `super-agent-user-management` and `admin-users`, and to the role/badge
-- display in every client screen.
--
-- THE REPAIR SIGNAL
-- -----------------
-- A badge is stale exactly when the account is NOT a super agent. The role is
-- read from `user_profiles` (authoritative) falling back to auth metadata,
-- mirroring what `admin-users` `normalizeRole` and the clients do. Only
-- accounts that resolve to something OTHER than `super_agent` are touched, so
-- a genuine super agent's badge is never disturbed.
--
-- IDEMPOTENT AND NON-DESTRUCTIVE
-- ------------------------------
-- Only super-agent-only keys are cleared, never a role, an email, a phone or a
-- name. Running it twice is a no-op because the second pass finds no stale
-- badge. A `null` is written rather than a key removal, so the row is left in
-- a state every existing reader already treats as "absent" - they all coerce
-- with `|| ""` or `String(x || "")`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. See what would change, BEFORE it is written
-- ---------------------------------------------------------------------------
-- Every row here is an account showing a Super Agent badge without being a
-- Super Agent. A non-zero count is expected and is the whole point.
--
--   SELECT u.id,
--          u.email,
--          lower(COALESCE(p.role, '')) AS profile_role,
--          lower(COALESCE(u.raw_app_meta_data ->> 'role',
--                          u.raw_user_meta_data ->> 'role', '')) AS auth_role,
--          u.raw_user_meta_data ->> 'super_agent_badge' AS user_badge,
--          u.raw_app_meta_data ->> 'super_agent_badge' AS app_badge
--     FROM auth.users u
--     LEFT JOIN public.user_profiles p ON p.id = u.id
--    WHERE (
--            COALESCE(u.raw_user_meta_data ->> 'super_agent_badge', '') <> ''
--         OR COALESCE(u.raw_app_meta_data ->> 'super_agent_badge', '') <> ''
--          )
--      AND lower(COALESCE(p.role, '')) <> 'super_agent';
--
-- The parentheses matter: `AND` binds tighter than `OR` in SQL, so without
-- them the role test would apply only to the `app_metadata` branch and the
-- query would also report super agents who still legitimately hold a badge.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 2. Clear the badge, in BOTH stores
-- ---------------------------------------------------------------------------
-- Both stores are cleared because they are NOT equivalent:
--   app_metadata  - service-role only. What the five Enterprise gates read.
--   user_metadata - writable by the user. What the client screens display.
-- Clearing only one leaves the account still rendering as an Enterprise super
-- agent, or still passing an Enterprise gate.
UPDATE auth.users AS u
   SET raw_user_meta_data = jsonb_set(
         COALESCE(u.raw_user_meta_data, '{}'::jsonb),
         '{super_agent_badge}',
         'null'::jsonb,
         true
       ),
       raw_app_meta_data = jsonb_set(
         COALESCE(u.raw_app_meta_data, '{}'::jsonb),
         '{super_agent_badge}',
         'null'::jsonb,
         true
       )
  FROM public.user_profiles AS p
 WHERE p.id = u.id
   -- A genuine super agent keeps its badge, whatever it is.
   AND lower(COALESCE(p.role, '')) <> 'super_agent'
   -- Only touch rows that actually carry a badge.
   AND (
     COALESCE(u.raw_user_meta_data ->> 'super_agent_badge', '') <> ''
     OR COALESCE(u.raw_app_meta_data ->> 'super_agent_badge', '') <> ''
   );

-- ---------------------------------------------------------------------------
-- 3. Clear a stale ROLE alias left in `user_metadata`
-- ---------------------------------------------------------------------------
-- `setUserRole` was supposed to remove `user_metadata.role` on a demotion to
-- normal_user, and that delete failed for the same merge-patch reason. A
-- leftover `role` here is what a client screen reads first, so an account
-- demoted days ago can still render as a super agent to the user even though
-- `user_profiles` says `normal_user`.
--
-- Scoped to the same "not a super agent" set, and to rows where
-- `app_metadata.role` is empty or also non-super-agent - so an account whose
-- `app_metadata.role` still says `super_agent` is left alone for an admin to
-- look at, rather than being silently downgraded here.
UPDATE auth.users AS u
   SET raw_user_meta_data = jsonb_set(
         COALESCE(u.raw_user_meta_data, '{}'::jsonb),
         '{role}',
         'null'::jsonb,
         true
       )
  FROM public.user_profiles AS p
 WHERE p.id = u.id
   AND lower(COALESCE(p.role, '')) <> 'super_agent'
   AND COALESCE(u.raw_user_meta_data ->> 'role', '') <> ''
   AND lower(COALESCE(u.raw_app_meta_data ->> 'role', '')) NOT IN
       ('super_agent', 'superagent');

-- ---------------------------------------------------------------------------
-- 4. Clear a stale `super_agent_id` on an account that is no longer an agent
-- ---------------------------------------------------------------------------
-- `verify-payment` reads `user_profiles.super_agent_id` (not this key) to
-- decide whose wallet funds a purchase, so this column is not what authorized
-- the stale agent behaviour - but the CLIENTS read this key, and a leftover
-- owner is what makes a normal user still render and behave like a sub-agent.
-- Left nulled rather than removed for the same reason as the badge.
--
-- `user_profiles.super_agent_id` is deliberately NOT touched here: it is the
-- authoritative ownership column the settlement chain depends on, and
-- `20260928_003` deliberately preserved it. Correcting it is an admin action.
UPDATE auth.users AS u
   SET raw_user_meta_data = jsonb_set(
         COALESCE(u.raw_user_meta_data, '{}'::jsonb),
         '{super_agent_id}',
         'null'::jsonb,
         true
       ),
       raw_app_meta_data = jsonb_set(
         COALESCE(u.raw_app_meta_data, '{}'::jsonb),
         '{super_agent_id}',
         'null'::jsonb,
         true
       )
 WHERE (
         COALESCE(u.raw_user_meta_data ->> 'super_agent_id', '') <> ''
         OR COALESCE(u.raw_app_meta_data ->> 'super_agent_id', '') <> ''
       )
   -- ...and only on an account that is not an agent. Without the parentheses
   -- above, `AND` binds tighter than `OR` and the role test would apply only to
   -- the app_metadata branch, clearing ownership off genuine sub-agents.
   AND lower(COALESCE(
               (SELECT role FROM public.user_profiles WHERE id = u.id),
               u.raw_app_meta_data ->> 'role',
               u.raw_user_meta_data ->> 'role', '')) <> 'sub_agent';

-- ---------------------------------------------------------------------------
-- 5. Verify
-- ---------------------------------------------------------------------------
-- No non-super-agent may carry a badge. Expect ZERO rows:
--
--   SELECT u.id, u.email, p.role,
--          u.raw_user_meta_data ->> 'super_agent_badge' AS user_badge,
--          u.raw_app_meta_data ->> 'super_agent_badge'  AS app_badge
--     FROM auth.users u
--     LEFT JOIN public.user_profiles p ON p.id = u.id
--    WHERE (COALESCE(u.raw_user_meta_data ->> 'super_agent_badge', '') <> ''
--        OR COALESCE(u.raw_app_meta_data ->> 'super_agent_badge', '') <> '')
--      AND lower(COALESCE(p.role, '')) <> 'super_agent';
--
-- Genuine super agents kept theirs (this should NOT be empty):
--
--   SELECT u.email, u.raw_app_meta_data ->> 'super_agent_badge' AS badge
--     FROM auth.users u
--     JOIN public.user_profiles p ON p.id = u.id
--    WHERE p.role = 'super_agent'
--      AND COALESCE(u.raw_app_meta_data ->> 'super_agent_badge', '') <> '';
--
-- NOTE: a `null` in JSONB is not the same as an absent key. Every badge reader
-- in this codebase coerces with `|| ""` or `String(x || "")`, so `null` reads
-- as "no badge" - but the role ladder in `UserManagementScreen` treats a
-- missing role as "Normal User", and these rows now satisfy that too.
--
-- Re-running steps 2-4 is a no-op: after the first pass every stale key is
-- `null`, which `COALESCE(...) <> ''` does not match.
-- ---------------------------------------------------------------------------

COMMIT;
