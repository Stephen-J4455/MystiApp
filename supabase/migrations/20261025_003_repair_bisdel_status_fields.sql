BEGIN;

-- Reconcile older Bisdel responses that exposed the native state as either
-- data.status or data.order_status. Do not infer a provider status from the
-- payment_transactions.status column; that column tracks the payment.
UPDATE public.orders
SET bisdel_order_status = COALESCE(
  CASE
    WHEN lower(COALESCE(bisdel_order_status, '')) IN ('true', 'false')
      THEN NULL
    ELSE bisdel_order_status
  END,
  CASE
    WHEN lower(COALESCE(jehuca_order_status, '')) IN ('true', 'false')
      THEN NULL
    ELSE jehuca_order_status
  END,
  jehuca_response #>> '{data,status}',
  jehuca_response #>> '{data,order_status}'
)
WHERE provider_name = 'bisdel'
  AND (
    bisdel_order_status IS NULL
    OR bisdel_order_status IN ('true', 'false')
  );

UPDATE public.agent_orders
SET bisdel_order_status = COALESCE(
  CASE
    WHEN lower(COALESCE(bisdel_order_status, '')) IN ('true', 'false')
      THEN NULL
    ELSE bisdel_order_status
  END,
  CASE
    WHEN lower(COALESCE(jehuca_order_status, '')) IN ('true', 'false')
      THEN NULL
    ELSE jehuca_order_status
  END,
  jehuca_response #>> '{data,status}',
  jehuca_response #>> '{data,order_status}'
)
WHERE provider_name = 'bisdel'
  AND (
    bisdel_order_status IS NULL
    OR bisdel_order_status IN ('true', 'false')
  );

UPDATE public.payment_transactions
SET bisdel_order_status = COALESCE(
  CASE
    WHEN lower(COALESCE(bisdel_order_status, '')) IN ('true', 'false')
      THEN NULL
    ELSE bisdel_order_status
  END,
  CASE
    WHEN lower(COALESCE(jehuca_order_status, '')) IN ('true', 'false')
      THEN NULL
    ELSE jehuca_order_status
  END,
  jehuca_response #>> '{data,status}',
  jehuca_response #>> '{data,order_status}'
)
WHERE provider_name = 'bisdel'
  AND (
    bisdel_order_status IS NULL
    OR bisdel_order_status IN ('true', 'false')
  );

-- Restore the app-owned state only for rows whose stored status was actually
-- the same value reported by an accepted Bisdel response.
UPDATE public.orders
SET status = 'processing'
WHERE provider_name = 'bisdel'
  AND jehuca_order_id IS NOT NULL
  AND jehuca_response ->> 'success' = 'true'
  AND (
    status = 'pending'
    OR status = bisdel_order_status
  );

UPDATE public.agent_orders
SET status = 'processing'
WHERE provider_name = 'bisdel'
  AND jehuca_order_id IS NOT NULL
  AND jehuca_response ->> 'success' = 'true'
  AND (
    status = 'pending'
    OR status = bisdel_order_status
  );

COMMIT;
