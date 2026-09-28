BEGIN;

-- ===========================================================================
-- New signups get `normal_user`, not `sub_agent`
-- ===========================================================================
-- WHY
-- ---
-- `handle_new_user()` (migration 20260920_001) inserted a hardcoded
-- 'sub_agent' for EVERY new auth user:
--
--     INSERT INTO public.user_profiles (id, role, ...)
--     VALUES (NEW.id, 'sub_agent', ...);
--
-- A customer who signed up with no role at all - i.e. a NORMAL USER, which is
-- exactly how the app represents that state (see `ROLE_LADDER` in
-- MystiAdminApp `UserManagementScreen.js`: "normal_user" means "no role
-- metadata") - was therefore recorded in the authoritative store as an agent.
--
-- `user_profiles.role` is what every edge function's `resolveIdentity` reads,
-- so this was not cosmetic: a normal user resolved as a sub-agent and kept
-- agent behaviour (ownership checks, assignment-derived affordances) from the
-- moment they signed up, with no admin action required to cause it.
--
-- The column DEFAULT was 'sub_agent' for the same reason and had the same
-- effect on any insert that omitted `role`.
--
-- Migration 20260925_004 already widened the CHECK constraint to include
-- 'normal_user', so the value is representable. Two earlier migrations
-- nonetheless still carried the expired premise that it was not
-- (`admin-users` setUserRole and 20260926_009) - those are fixed separately.
-- This migration fixes the ORIGIN of the bad rows: new signups.
--
-- SAFE / NON-DESTRUCTIVE
-- ---------------------
-- This migration only changes the constraint, the trigger and the column
-- default. It does NOT touch existing rows - 20260928_001 repairs those,
-- because correcting them here would silently reclassify accounts an admin had
-- deliberately set.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Ensure the CHECK constraint actually permits 'normal_user'
-- ---------------------------------------------------------------------------
-- Step 1 is deliberately FIRST: every statement below writes that value, and
-- a single unapplied 20260925_004 would otherwise abort the whole migration
-- mid-way. `CREATE TABLE IF NOT EXISTS` in 20260920_001 declares the narrow
-- constraint INLINE, so its generated name is not guaranteed - it is found by
-- resolving `conkey` to the column name rather than by a loose LIKE on the
-- definition text, which could match an unrelated constraint.
--
-- The same DO block, for the same reason, as 20260925_004. Re-running is a
-- no-op: it drops whatever CHECK sits on `role` and re-adds the wide one.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN unnest(c.conkey) AS key(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
    WHERE c.conrelid = 'public.user_profiles'::regclass
      AND c.contype = 'c'
      AND a.attname = 'role'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.user_profiles DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$$;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('normal_user', 'super_agent', 'sub_agent', 'admin'));

-- ---------------------------------------------------------------------------
-- 2. Derive the role from metadata on insert, defaulting to normal_user
-- ---------------------------------------------------------------------------
-- `app_metadata` is consulted first because the account cannot write it;
-- `user_metadata` second because the account CAN. Both are consulted only to
-- SEED a new row - no authorization decision is made from them here, since
-- `resolveIdentity` re-reads the stored profile on every request.
--
-- The mapping mirrors `admin-users` `normalizeRole`: agent|agent|sub_agent ->
-- sub_agent, superagent|super_agent -> super_agent, admin -> admin, anything
-- else (including absent) -> normal_user.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.user_profiles (id, role, email, full_name, business_name)
  VALUES (
    NEW.id,
    COALESCE(
      CASE lower(btrim(COALESCE(NEW.raw_app_meta_data ->> 'role', '')))
        WHEN 'admin' THEN 'admin'
        WHEN 'superagent' THEN 'super_agent'
        WHEN 'super_agent' THEN 'super_agent'
        WHEN 'agent' THEN 'sub_agent'
        WHEN 'sub_agent' THEN 'sub_agent'
      END,
      CASE lower(btrim(COALESCE(NEW.raw_user_meta_data ->> 'role', '')))
        WHEN 'admin' THEN 'admin'
        WHEN 'superagent' THEN 'super_agent'
        WHEN 'super_agent' THEN 'super_agent'
        WHEN 'agent' THEN 'sub_agent'
        WHEN 'sub_agent' THEN 'sub_agent'
      END,
      -- No role in either store: a normal user. This is the change. It used to
      -- be 'sub_agent', which granted every new signup agent behaviour.
      'normal_user'
    ),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'business_name'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 3. Default the column too
-- ---------------------------------------------------------------------------
-- Any INSERT that omits `role` explicitly (admin tooling, backfills, manual
-- fixes) previously inherited 'sub_agent' silently. `normal_user` is the
-- correct fail-closed default: it grants nothing, and any real role is
-- written explicitly.
ALTER TABLE public.user_profiles
  ALTER COLUMN role SET DEFAULT 'normal_user';

-- ---------------------------------------------------------------------------
-- 4. Verify
-- ---------------------------------------------------------------------------
-- Role distribution. `normal_user` should now be the largest bucket, and
-- every one of those accounts signed up without a role:
--
--   SELECT role, count(*) FROM public.user_profiles GROUP BY role ORDER BY role;
--
-- Existing rows were NOT touched by this migration, so any normal user who
-- signed up before it still reads 'sub_agent' until 20260928_001 runs.
-- Cross-check those two together:
--
--   SELECT p.role, count(*)
--     FROM public.user_profiles p
--     JOIN auth.users u ON u.id = p.id
--    WHERE COALESCE(u.raw_app_meta_data->>'role','') = ''
--      AND COALESCE(u.raw_user_meta_data->>'role','') = ''
--    GROUP BY p.role;
--
-- Expect every row to read 'normal_user' once BOTH migrations have been
-- applied. Anything still reading 'sub_agent' there is a leftover.
-- ---------------------------------------------------------------------------

COMMIT;
