BEGIN;

ALTER TABLE public.super_agent_offers
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'jehuca'
    CHECK (provider IN ('jehuca', 'bisdel'));

CREATE INDEX IF NOT EXISTS idx_super_agent_offers_provider_active
  ON public.super_agent_offers(provider, super_agent_id, is_active);

COMMIT;
