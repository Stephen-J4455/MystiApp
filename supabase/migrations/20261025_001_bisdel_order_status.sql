BEGIN;

ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS bisdel_order_status text;

ALTER TABLE IF EXISTS public.agent_orders
  ADD COLUMN IF NOT EXISTS bisdel_order_status text;

ALTER TABLE IF EXISTS public.payment_transactions
  ADD COLUMN IF NOT EXISTS bisdel_order_status text;

UPDATE public.orders
SET bisdel_order_status = jehuca_order_status
WHERE provider_name = 'bisdel'
  AND bisdel_order_status IS NULL
  AND jehuca_order_status IS NOT NULL;

UPDATE public.agent_orders
SET bisdel_order_status = jehuca_order_status
WHERE provider_name = 'bisdel'
  AND bisdel_order_status IS NULL
  AND jehuca_order_status IS NOT NULL;

UPDATE public.payment_transactions
SET bisdel_order_status = jehuca_order_status
WHERE provider_name = 'bisdel'
  AND bisdel_order_status IS NULL
  AND jehuca_order_status IS NOT NULL;

COMMIT;
