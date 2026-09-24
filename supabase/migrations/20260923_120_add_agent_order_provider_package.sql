BEGIN;

ALTER TABLE IF EXISTS public.agent_orders
  ADD COLUMN IF NOT EXISTS provider_package_id text,
  ADD COLUMN IF NOT EXISTS provider_type text,
  ADD COLUMN IF NOT EXISTS provider_size numeric;

CREATE INDEX IF NOT EXISTS idx_agent_orders_provider_package_id
  ON public.agent_orders(provider_package_id);

COMMIT;
