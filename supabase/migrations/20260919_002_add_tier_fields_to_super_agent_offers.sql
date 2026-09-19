BEGIN;

ALTER TABLE IF EXISTS public.super_agent_offers
  ADD COLUMN IF NOT EXISTS tier_name text,
  ADD COLUMN IF NOT EXISTS default_tier_name text,
  ADD COLUMN IF NOT EXISTS tier_description text;

CREATE INDEX IF NOT EXISTS idx_super_agent_offers_tier_name
  ON public.super_agent_offers (super_agent_id, tier_name);

COMMIT;
