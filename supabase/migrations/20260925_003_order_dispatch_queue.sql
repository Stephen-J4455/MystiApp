BEGIN;

-- Provider dispatch tracking for normal-user orders.
--
-- agent_orders already has provider_package_id / provider_type / provider_size
-- and the jehuca_* columns (migrations 120 and 001), but the `orders` table
-- never got them. Without these columns a normal-user order cannot be
-- re-dispatched to Jehuca later, because the provider package id, type and
-- size are not recoverable from anything else on the row.
ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS provider_package_id text,
  ADD COLUMN IF NOT EXISTS provider_type text,
  ADD COLUMN IF NOT EXISTS provider_size numeric,
  ADD COLUMN IF NOT EXISTS jehuca_order_id text,
  ADD COLUMN IF NOT EXISTS jehuca_order_status text,
  ADD COLUMN IF NOT EXISTS jehuca_response jsonb,
  ADD COLUMN IF NOT EXISTS base_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agent_markup numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transaction_fee numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS main_account_amount numeric DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_provider_package_id
  ON public.orders(provider_package_id);
CREATE INDEX IF NOT EXISTS idx_orders_jehuca_order_id
  ON public.orders(jehuca_order_id);

-- Orders that are paid for but not yet handed to the provider. The admin app
-- lists these and offers a "Send to Jehuca" action once the API account has
-- been funded.
--
-- provider_deferred_reason is 'insufficient_api_balance' when the admin's
-- Jehuca balance could not cover the order cost, or 'provider_rejected' when
-- the provider refused the order. Both leave the order in 'pending'.
ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS provider_deferred_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_deferred_reason text,
  ADD COLUMN IF NOT EXISTS provider_dispatch_attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_provider_deferred
  ON public.orders(provider_deferred_at DESC)
  WHERE status = 'pending' AND jehuca_order_id IS NULL;

ALTER TABLE IF EXISTS public.agent_orders
  ADD COLUMN IF NOT EXISTS provider_deferred_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_deferred_reason text,
  ADD COLUMN IF NOT EXISTS provider_dispatch_attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_agent_orders_provider_deferred
  ON public.agent_orders(provider_deferred_at DESC)
  WHERE status = 'pending' AND jehuca_order_id IS NULL;

COMMIT;
