BEGIN;

-- Lets an admin change an AFA registration's status from the admin app.
--
-- afa_registrations had no UPDATE policy at all: users could read and insert
-- their own registration, but nobody could correct a status after the fact
-- (e.g. marking a rejected registration active, or recording a manual
-- refund). The status CHECK already allows the values below, so this only
-- adds the permission, not new states.
--
-- The role check is case-insensitive on purpose. Existing policies in this
-- schema compare against 'Admin' exactly, which only matches an account whose
-- role was stored capitalised; lowercasing the value keeps this policy working
-- whichever form the admin account happens to use.
DROP POLICY IF EXISTS afa_registrations_admin_update ON public.afa_registrations;
CREATE POLICY afa_registrations_admin_update ON public.afa_registrations
  FOR UPDATE TO authenticated
  USING (
    lower(auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    OR lower(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
  WITH CHECK (
    lower(auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    OR lower(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- Records who last changed a status and when, so a manual correction is
-- traceable in the same row.
ALTER TABLE public.afa_registrations
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status_note text;

CREATE INDEX IF NOT EXISTS idx_afa_registrations_status
  ON public.afa_registrations(status, created_at DESC);

COMMIT;
