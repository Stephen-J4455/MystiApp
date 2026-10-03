BEGIN;

-- ===========================================================================
-- Backfill: dispatched Sub-Agent orders are SETTLED, not "Pending"
-- ===========================================================================
-- APPLY AFTER: 20260928_013 (order_processing_status)
-- APPLY AFTER: the `dispatch-order` change that settles on hand-off.
--
-- THE BUG
-- -------
-- `verify-payment` writes, for every Sub-Agent order:
--
--     agent_orders.settlement_status            = 'pending'
--     payment_transactions.settlement_status    = 'pending'
--
-- 'pending' is CORRECT at that moment: Paystack has charged the customer, but
-- the platform has not yet released the super agent's share.
--
-- The problem is that NOTHING EVER MOVED IT. Grepping every writer of
-- settlement_status across the codebase finds exactly one transition:
--
--     reorder-held-agent-order -> settlement_status = 'settled'
--
-- so a reordered HELD order settled, while an ordinary order that dispatched
-- normally on its first attempt - the overwhelmingly common path - stayed
-- 'pending' FOREVER.
--
-- WHY IT LOOKED LIKE AN ORDER-STATUS PROBLEM AND WAS NOT
-- ---------------------------------------------------
-- The admin Transactions screen renders `settlement_status || status`. That
-- `||` makes the two indistinguishable on screen: both 'pending' and 'stuck
-- pending' render as the word "Pending". So the symptom was reported as
-- "the order starts pending and only becomes processing when the admin
-- updates the status".
--
-- That second half is the tell. The admin changes `agent_orders.status` -
-- a DIFFERENT column on a DIFFERENT table - and the Transactions screen never
-- reads that column at all. It reads `payment_transactions`. So the admin's
-- manual edit genuinely could not change what the Transactions screen showed,
-- no matter how many times it was repeated. That is the signature of this bug
-- and not of a status-transition gap in the order table.
--
-- WHAT MOVES
-- ----------
-- Only rows that were demonstrably handed to the provider, i.e. carrying a
-- `jehuca_order_id`. That column is written by `dispatch-order` and
-- `reorder-held-agent-order` ONLY on a confirmed provider acceptance, so its
-- presence is positive evidence the money was committed and the split
-- released. It is never written on a deferral or a rejection.
--
-- EXPLICITLY NOT TOUCHED
-- ----------------------
--   - Anything without a `jehuca_order_id`. Never dispatched, so the split has
--     genuinely not been released. Leaving these 'pending' is the honest state.
--   - 'failed' rows. A held order that expired is settled by
--     `expire_stale_held_agent_orders`, not here.
--
-- WHY BOTH TABLES
-- ---------------
-- The admin Transactions screen reads `payment_transactions`; the admin Orders
-- screen reads `agent_orders`. Settling only one of them leaves the same
-- invisible-stuck value on the other, which is how this recurred in the first
-- place. They are joined on `order_id` because `payment_transactions.order_id`
-- is written for the agent path and `agent_orders` is the table it describes.
--
-- SAFE / IDEMPOTENT
-- ------------------
-- Single UPDATE per table, restricted to `settlement_status = 'pending'` plus
-- the `jehuca_order_id` test, so nothing outside that one value can be
-- affected. No amount, reference, provider id or settlement figure is touched.
-- Re-running is a no-op.
-- ===========================================================================

-- The order row.
UPDATE public.agent_orders
   SET settlement_status = 'settled'
 WHERE settlement_status = 'pending'
   AND jehuca_order_id IS NOT NULL;

-- The ledger row the Transactions screen actually reads.
--
-- Correlated on `order_id` rather than `payment_reference`: `order_id` is the
-- column `verify-payment` populates on the agent path, whereas the reference
-- lives on `agent_orders.payment_reference` and is NULL on historical agent
-- rows that predate migration 20260926_008. Joining on a column that is often
-- NULL would silently settle a subset and leave the bug alive in the rest.
UPDATE public.payment_transactions AS pt
   SET settlement_status = 'settled'
 WHERE pt.settlement_status = 'pending'
   AND pt.order_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM public.agent_orders AS ao
      WHERE ao.id = pt.order_id
        AND ao.jehuca_order_id IS NOT NULL
   );

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Every remaining 'pending' settlement must now be explainable: it is an order
-- that never reached the provider. Expect a small number, or zero.
--
--   SELECT 'agent_orders' AS tbl, settlement_status, count(*)
--     FROM public.agent_orders
--    WHERE settlement_status = 'pending'
--    GROUP BY settlement_status
--   UNION ALL
--   SELECT 'payment_transactions', settlement_status, count(*)
--     FROM public.payment_transactions
--    WHERE settlement_status = 'pending'
--    GROUP BY settlement_status;
--
-- Cross-check that nothing was settled that was never dispatched - expect 0:
--
--   SELECT count(*) AS wrongly_settled
--     FROM public.agent_orders
--    WHERE settlement_status = 'settled'
--      AND jehuca_order_id IS NULL
--      AND status <> 'cancelled';
--
-- And that dispatched orders are no longer stuck - expect 0:
--
--   SELECT count(*) AS stuck_dispatched
--     FROM public.agent_orders
--    WHERE jehuca_order_id IS NOT NULL
--      AND settlement_status = 'pending';
--
-- A non-zero `stuck_dispatched` here means some writer outside this migration
-- resets the value. Do NOT blanket-update again - find the writer first.

COMMIT;
