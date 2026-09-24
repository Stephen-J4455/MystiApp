BEGIN;

-- Allow a user to request another AFA registration. Each request has its own
-- immutable payment reference and ledger entry, while an individual request
-- remains protected by its own payment reference.
DROP INDEX IF EXISTS public.idx_afa_registrations_user_active;

CREATE INDEX IF NOT EXISTS idx_afa_registrations_user_status_created
  ON public.afa_registrations (registered_user_id, status, created_at DESC);

COMMIT;
