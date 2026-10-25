BEGIN;

-- Older Bisdel deployments stored the provider's native status in `status`.
-- Recover it only when it matches the raw Bisdel response, then restore the
-- app-owned lifecycle status for accepted orders. Payment transaction status
-- is intentionally untouched because it represents payment state.
UPDATE public.orders
SET bisdel_order_status = status
WHERE provider_name = 'bisdel'
  AND jehuca_order_id IS NOT NULL
  AND bisdel_order_status IS NULL
  AND status IS NOT NULL
  AND status = (jehuca_response -> 'data' ->> 'status');

UPDATE public.agent_orders
SET bisdel_order_status = status
WHERE provider_name = 'bisdel'
  AND jehuca_order_id IS NOT NULL
  AND bisdel_order_status IS NULL
  AND status IS NOT NULL
  AND status = (jehuca_response -> 'data' ->> 'status');

UPDATE public.orders
SET status = 'processing'
WHERE provider_name = 'bisdel'
  AND jehuca_order_id IS NOT NULL
  AND status = bisdel_order_status;

UPDATE public.agent_orders
SET status = 'processing'
WHERE provider_name = 'bisdel'
  AND jehuca_order_id IS NOT NULL
  AND status = bisdel_order_status;

COMMIT;
