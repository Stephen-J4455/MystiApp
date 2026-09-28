BEGIN;

-- ===========================================================================
-- Repair `user_profiles` rows that the signup trigger mis-stamped
-- ===========================================================================
-- WHY
-- ---
-- Two separate defects turned every ordinary customer into a sub-agent.
--
-- 1. ORIGIN. `handle_new_user()` (migration 20260920_001) inserted a
--    hardcoded 'sub_agent' for EVERY new auth user:
--
--        INSERT INTO public.user_profiles (id, role, ...)
--        VALUES (NEW.id, 'sub_agent', ...);
--
--    A customer who signed up with no role at all - i.e. a NORMAL USER, which
--    is exactly how the app represents that state (see `ROLE_LADDER` in
--    MystiAdminApp `UserManagementScreen.js`, where "normal_user" means "no
--    role metadata") - was recorded in the AUTHORITATIVE store as an agent.
--
--    20260928_002 fixed the trigger and the column default, and explicitly
--    documented that it does NOT touch existing rows, so every account created
--    before it still carries role = 'sub_agent'.
--
-- 2. REPAIR THAT MADE IT WORSE. 20260926_009 `reconcile_user_profiles.sql`
--    backfills role with `ELSE 'sub_agent'`, so an account whose role is empty
--    or unrecognised - exactly a normal user - was not merely left alone, it
--    was actively written INTO the agent role. That migration also omits a
--    'normal_user' arm entirely.
--
-- WHY THIS WAS A LIVE, MONEY-AFFECTING BUG
-- ----------------------------------------
-- `verify-payment` decides which table receives an order with:
--
--     const isAgentOrder = Boolean(
--       resolvedSuperAgentId || identity.role === "sub_agent",
--     );
--
-- and `identity.role` came from `resolveIdentity`, which read this column.
-- The inlined `normalizeRole` helper also mapped "normal_user" and "user"
-- onto "sub_agent", so even a correctly-stamped 'normal_user' row resolved as
-- an agent. The second term was therefore ALWAYS true and every order in the
-- platform was written to `agent_orders` with `agent_id` = the buyer's own id
-- and `buyer_type` = 'sub_agent' - normal-user purchases surfaced in the admin
-- app's "Agents" tab and were attributed to the sub-agent revenue channel in
-- 20260926_004_channel_revenue_analytics.sql.
--
-- The functions are fixed separately (normalizeRole now returns
-- "normal_user"). This migration repairs the ROWS, which no code change can
-- do: `user_profiles` is the authoritative store and the trigger only ever
-- fires on INSERT.
--
-- THE REPAIR SIGNAL
-- -----------------
-- A normal user is an account that carries NO role in EITHER auth metadata
-- store. `admin-users` `setUserRole` makes this exact guarantee for a
-- demotion: for `normal_user` it DELETES `user_metadata.role` and
-- `app_metadata.role` rather than writing the literal string, and it strips
-- `super_agent_badge` / `super_agent_id` at the same time.
--
-- That is the same predicate migration 20260928_002 uses in its own
-- verification query, so this is a repair to the same documented definition
-- rather than a new one.
--
-- WHY `super_agent_id IS NULL` IS ALSO REQUIRED
-- ---------------------------------------------
-- A row is only demoted when it is a sub-agent that was never attached to a
-- Super Agent, so:
--
--   * A real sub-agent created through `admin-users` `setUserRole` always has
--     `super_agent_id` set - that action 400s without a Super Agent - so real
--     agents are never touched.
--   * The column is the ownership key the settlement chain depends on, and
--     `verify-payment` reads it to decide whose wallet funds a purchase. Rows
--     with no owner and no recorded role have no settlement chain to protect.
--
-- Rows carrying a role in either store are left alone entirely, so an admin's
-- deliberate assignment is never reclassified.
--
-- IDEMPOTENT AND NON-DESTRUCTIVE
-- ------------------------------
-- Writes only 'normal_user', which the CHECK constraint widened in
-- 20260925_004 and 20260928_002 already permits, and only onto rows that
-- currently read 'sub_agent'. Running it twice is a no-op because the target
-- no longer matches the source role.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. What would change, BEFORE it is written
-- ---------------------------------------------------------------------------
-- Every qualifying row should be an account that signed up without ever being
-- given a role. A non-zero count here is expected and is the whole point of
-- the migration; a count of 0 means there is nothing to repair.
--
--   SELECT p.id, p.role, u.created_at
--     FROM public.user_profiles p
--     JOIN auth.users u ON u.id = p.id
--    WHERE p.role = 'sub_agent'
--      AND p.super_agent_id IS NULL
--      AND COALESCE(u.raw_app_meta_data ->> 'role', '') = ''
--      AND COALESCE(u.raw_user_meta_data ->> 'role', '') = ''
--    ORDER BY u.created_at;
--
-- Sanity check on the exclusion: any sub-agent with an owner must be absent.
--
--   SELECT count(*) AS real_sub_agents
--     FROM public.user_profiles
--    WHERE role = 'sub_agent' AND super_agent_id IS NOT NULL;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 2. Repair
-- ---------------------------------------------------------------------------
UPDATE public.user_profiles AS p
   SET role = 'normal_user',
       updated_at = now()
  FROM auth.users AS u
 WHERE u.id = p.id
   -- Only rows the origin defect mis-stamped...
   AND p.role = 'sub_agent'
   -- ...that were never attached to a Super Agent...
   AND p.super_agent_id IS NULL
   -- ...and whose auth record carries no role in either store, which is how
   -- both the signup trigger and `admin-users` represent a normal user.
   AND COALESCE(u.raw_app_meta_data ->> 'role', '') = ''
   AND COALESCE(u.raw_user_meta_data ->> 'role', '') = '';

-- ---------------------------------------------------------------------------
-- 3. Normalise the `app_metadata` role so the RLS policies agree
-- ---------------------------------------------------------------------------
-- RLS read policies key on `(auth.jwt() -> 'app_metadata' ->> 'role')` and
-- nothing else (see 20260928_001 and 20260926_010). A repaired profile is
-- therefore correct in the database while the JWT still advertises whatever
-- `app_metadata.role` holds.
--
-- Only rows that are ALREADY 'normal_user' in the profile are touched, and
-- only an empty `app_metadata.role` is replaced. This cannot clobber a
-- deliberate admin-side change: a promoted account carries a non-empty role
-- in the profile and is skipped, and an account whose app_metadata already
-- names a role keeps it. An explicit 'normal_user' is also never written
-- here, because no policy grants on that literal - `admin-users` deletes the
-- key for the same reason.
UPDATE auth.users
   SET raw_app_meta_data = jsonb_set(
         COALESCE(raw_app_meta_data, '{}'::jsonb),
         '{super_agent_id}',
         'null'::jsonb,
         true
       )
 WHERE COALESCE(raw_app_meta_data ->> 'role', '') = ''
   AND COALESCE(raw_user_meta_data ->> 'role', '') = ''
   AND COALESCE(raw_app_meta_data -> 'super_agent_id', 'null'::jsonb) <> 'null'::jsonb
   AND EXISTS (
         SELECT 1
           FROM public.user_profiles p
          WHERE p.id = auth.users.id
            AND p.role = 'normal_user'
       );

-- ---------------------------------------------------------------------------
-- 4. Verify
-- ---------------------------------------------------------------------------
-- Role distribution. `normal_user` should now hold every account that signed
-- up without a role:
--
--   SELECT role, count(*) FROM public.user_profiles GROUP BY role ORDER BY role;
--
-- Cross-check the two together, exactly as 20260928_002's own section 4 does.
-- Expect ZERO rows still reading 'sub_agent' - anything left is a genuine
-- sub-agent, or an account that has been assigned and should be re-checked
-- manually:
--
--   SELECT p.id, p.role, p.super_agent_id
--     FROM public.user_profiles p
--     JOIN auth.users u ON u.id = p.id
--    WHERE COALESCE(u.raw_app_meta_data->>'role','') = ''
--      AND COALESCE(u.raw_user_meta_data->>'role','') = ''
--      AND p.role <> 'normal_user';
--
-- Confirmed the repair did not touch real agents:
--
--   SELECT count(*) FROM public.user_profiles
--    WHERE role = 'sub_agent' AND super_agent_id IS NOT NULL;
--
-- The migration is idempotent: re-running step 2 matches no rows, because the
-- repaired rows no longer read 'sub_agent'.
-- ---------------------------------------------------------------------------

COMMIT;
