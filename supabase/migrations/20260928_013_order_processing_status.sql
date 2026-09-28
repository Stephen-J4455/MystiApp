BEGIN;

-- ===========================================================================
-- Backfill: live orders should read 'processing', not 'pending'
-- ===========================================================================
-- APPLY AFTER: 007, 008, 010, 009, 011, 012
-- Independent of the wallet migrations - safe to run any time after the code
-- deploy.
--
-- WHY
-- ---
-- `verify-payment` and `reorder-held-agent-order` now CREATE and complete
-- orders as 'processing', because the payment is verified before the row is
-- written and there is nothing left to wait for. 'pending' is reserved for the
-- one case that genuinely means waiting: `dispatch-order` could not hand the
-- order to the provider, so it downgrades the row to 'pending' with a
-- `provider_deferred_*` reason.
--
-- Every order created BEFORE that change is sitting in 'pending' whether or not
-- it was ever dispatched, so the admin's list showed a wall of orders that
-- looked stuck. The 'Processing' filter was near-empty and 'Pending' was
-- near-full, which is the exact inverse of reality.
--
-- WHAT MOVES
-- ----------
-- A `pending` order moves to `processing` ONLY when it has no deferred reason
-- recorded. Those markers are written by the same `dispatch-order` block that
-- sets the status, so their presence is reliable evidence that 'pending' is
-- load-bearing for that row and must not be overwritten.
--
-- EXPLICITLY NOT TOUCHED
-- ----------------------
--   - Anything with a `provider_deferred_*` marker. Genuinely waiting.
--   - Anything already dispatched (`jehuca_order_id IS NOT NULL`). Those were
--     never stuck; a 'pending' status on a dispatched order is the
--     `reorder-held-agent-order` inversion, fixed in code. Correcting them here
--     too keeps the list honest, and is safe because the row is past the point
--     of being deferred.
--   - `held` and `cancelled`. The held-order sweep in 20260927_001 keys on
--     `status = 'held'` and sets its own `held_expires_at`; rewriting those
--     rows would disarm the deadline and strand orders that are genuinely
--     waiting for a wallet top-up.
--
-- SAFE / NON-DESTRUCTIVE
-- ----------------------
-- A single UPDATE restricted to `status = 'pending'`, so nothing outside that
-- one value can be affected. No amount, reference, provider id or settlement
-- field is touched. Re-running is a no-op.
-- ===========================================================================

UPDATE public.orders
   SET status = 'processing'
 WHERE status = 'pending'
   AND jehuca_order_id IS NULL
   AND provider_deferred_at IS NULL
   AND provider_deferred_reason IS NULL;

UPDATE public.agent_orders
   SET status = 'processing'
 WHERE status = 'pending'
   AND jehuca_order_id IS NULL
   AND provider_deferred_at IS NULL
   AND provider_deferred_reason IS NULL;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- What moved, and what deliberately did not:
--
--   SELECT 'orders' AS tbl, status, count(*)
--     FROM public.orders
--    WHERE status IN ('pending', 'processing', 'held')
--    GROUP BY status
--   UNION ALL
--   SELECT 'agent_orders', status, count(*)
--     FROM public.agent_orders
--    WHERE status IN ('pending', 'processing', 'held')
--    GROUP BY status;
--
-- A healthy system has a small 'pending' bucket - only genuinely deferred
-- orders - and a large 'processing' one.
--
-- Every remaining 'pending' row must be explainable. Expect 0:
--
--   SELECT count(*) AS unexplained_pending
--     FROM (
--       SELECT id FROM public.orders
--        WHERE status = 'pending'
--          AND jehuca_order_id IS NULL
--          AND provider_deferred_at IS NULL
--          AND provider_deferred_reason IS NULL
--       UNION ALL
--       SELECT id FROM public.agent_orders
--        WHERE status = 'pending'
--          AND jehuca_order_id IS NULL
--          AND provider_deferred_at IS NULL
--          AND provider_deferred_reason IS NULL
--     ) AS leftovers;
--
-- A non-zero count here means some table has a 'pending' writer this migration
-- did not account for. Do NOT move those blindly - find the code path first.
--
-- The held-order deadline is still armed after this migration - expect 0:
--
--   SELECT count(*) AS held_missing_deadline
--     FROM public.agent_orders
--    WHERE status = 'held' AND held_expires_at IS NULL;
-- ---------------------------------------------------------------------------

COMMIT;
