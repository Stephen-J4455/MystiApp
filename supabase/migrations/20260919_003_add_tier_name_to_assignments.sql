BEGIN;

ALTER TABLE IF EXISTS public.super_agent_assignments
  ADD COLUMN IF NOT EXISTS tier_name text,
  ADD COLUMN IF NOT EXISTS agent_price numeric;

CREATE INDEX IF NOT EXISTS idx_super_agent_assignments_tier_name
  ON public.super_agent_assignments (super_agent_id, tier_name);

COMMIT;
