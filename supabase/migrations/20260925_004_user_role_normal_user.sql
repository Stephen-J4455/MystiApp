BEGIN;

-- The admin app can now set a user's role in all directions, including
-- demoting a Super Agent or Agent back to a Normal User.
--
-- user_profiles.role has a CHECK constraint that predates the "normal user"
-- state and only allows 'super_agent', 'sub_agent' and 'admin', so a demoted
-- user has no representable value there. Rather than leaving that table
-- silently stale, widen the constraint to include 'normal_user'.
--
-- The constraint is dropped by inspecting pg_constraint rather than by name
-- because it was declared inline, so its generated name is not guaranteed.
DO $$
DECLARE
  constraint_name text;
BEGIN
  -- Match the CHECK constraint on the role column specifically, by resolving
  -- conkey to the column name, rather than by a loose LIKE on the definition
  -- text which could catch an unrelated constraint.
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

CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON public.user_profiles(role);

COMMIT;
