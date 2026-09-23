BEGIN;

ALTER TABLE IF EXISTS public.agent_orders
  ADD COLUMN IF NOT EXISTS jehuca_order_id text,
  ADD COLUMN IF NOT EXISTS jehuca_order_status text,
  ADD COLUMN IF NOT EXISTS jehuca_response jsonb;

CREATE INDEX IF NOT EXISTS idx_agent_orders_jehuca_order_id
  ON public.agent_orders (jehuca_order_id);

COMMIT;