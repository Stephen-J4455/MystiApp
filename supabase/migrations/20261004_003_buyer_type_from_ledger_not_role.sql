BEGIN;

-- ===========================================================================
-- `cancel_admin_order`: decide wallet-refund eligibility from the LEDGER,
-- not from `orders.buyer_type`
-- ===========================================================================
-- APPLY AFTER: 20261003_001 (settle_dispatched_agent_orders)
--
-- WHY THIS IS NEEDED
-- ------------------
-- `verify-payment` stopped hardcoding `buyer_type: 'super_agent'` on wallet
-- `orders` rows and now writes the BUYER's actual role:
--
--     buyer_type: isSuperAgent ? 'super_agent' : 'sub_agent'
--
-- A sub-agent's wallet purchase is debited from their super agent's wallet,
-- which is why the value was hardcoded - the money's SOURCE and the buyer's
-- IDENTITY were conflated into one column. They are different questions, and
-- `orderOrigin.js` in the admin app already read this column as the buyer's
-- identity, so every sub-agent wallet order rendered as "Super Agent Order".
--
-- THE COUPLING THIS BREAKS
-- -----------------------
-- `cancel_admin_order` (migration 20260930_001) gates the wallet refund on
-- that same column:
--
--     IF order_buyer_type <> 'super_agent' THEN
--       -- cancel with no refund: "normal_user_payment_requires_provider_refund"
--     END IF;
--
-- Its stated reason was that a normal user's order was paid to Paystack and so
-- has no wallet to credit. That reasoning is about WHERE THE MONEY CAME FROM,
-- and it is still exactly right - but `buyer_type` was only ever a proxy for
-- it. Now that the column honestly records the buyer, the proxy is inverted
-- for the one case that matters: a sub-agent's wallet order would read
-- 'sub_agent', fail the gate, be cancelled, and refund NOTHING while both
-- wallets stayed debited.
--
-- That is money vanishing on an admin cancellation, so this has to move in the
-- same release as the write-side change.
-- ---------------------------------------------------------------------------
-- WHY THE LEDGER IS THE RIGHT SOURCE
-- ----------------------------------
-- 20260930_001 already rebuilt the refund to loop over the ledger:
--
--     SELECT ledger.super_agent_id, SUM(-ledger.amount)
--       FROM super_agent_wallet_ledger AS ledger
--      WHERE ledger.order_id = p_order_id AND ledger.entry_type = 'debit'
--      GROUP BY ledger.super_agent_id
--
-- So the function ALREADY asks "which wallets was this order debited from" -
-- it just gates that question behind a column. If the answer comes back
-- non-empty, the money came from a wallet and must be returned. If it is
-- empty, the order was paid to Paystack and needs a provider refund instead.
--
-- The gate therefore becomes a restatement of the loop it was protecting, and
-- the two can no longer disagree. It also needs no role, no buyer type, and no
-- knowledge of whether a mirror is involved - which is what makes it correct
-- for a super agent, a sub agent, and any future third mirrored side at once.
--
-- The `orders.user_id` capture for the normal branch is retained only to
-- populate the response's `refunded_to`, which is still meaningful for a
-- genuine Paystack order's reporting.
-- ---------------------------------------------------------------------------
-- BEHAVIOUR IS UNCHANGED FOR EVERY EXISTING ROW
-- ---------------------------------------------
-- This is a logic change, not a data change. No `buyer_type` value is rewritten
-- anywhere, so:
--
--   - a super agent's wallet order  ('super_agent') -> refunded, before and after
--   - a normal user's Paystack order ('normal_user') -> no wallet refund, before
--     and after
--   - a SUB-AGENT's wallet order    ('sub_agent')   -> refunded NOW, previously
--     cancelled with nothing returned. That is the fix, and it is the only
--     behaviour difference.
--
-- Rows written before this release keep their old literal, which the ledger
-- test ignores entirely - so the new rows and the old rows take the same path.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_admin_order(
  p_order_type text,
  p_order_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_status text;
  order_super_agent_id uuid;
  refund_wallet_owner uuid;
  refund_amount numeric;
  refund_reference text;
  refund_result jsonb;
  refund_reason text;
  order_buyer_type text;
  debited_wallets uuid[];
  side record;
  refunded_wallets jsonb := '[]'::jsonb;
  total_refunded numeric := 0;
BEGIN
  IF p_order_type NOT IN ('agent', 'normal') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;

  IF p_order_type = 'agent' THEN
    SELECT status, super_agent_id
      INTO order_status, order_super_agent_id
      FROM public.agent_orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Agent order not found';
    END IF;

    IF order_status = 'cancelled' THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_cancelled', true,
        'refunded', false
      );
    END IF;

    IF order_status NOT IN ('pending', 'processing', 'held') THEN
      RAISE EXCEPTION 'Only pending, processing, or held orders can be cancelled';
    END IF;

    refund_wallet_owner := order_super_agent_id;
    refund_reason := 'admin_cancelled_agent_order';
  ELSE
    SELECT status, COALESCE(buyer_type, ''), user_id
      INTO order_status, order_buyer_type, refund_wallet_owner
      FROM public.orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order not found';
    END IF;

    IF order_status = 'cancelled' THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_cancelled', true,
        'refunded', false
      );
    END IF;

    IF order_status NOT IN ('pending', 'processing') THEN
      RAISE EXCEPTION 'Only pending or processing orders can be cancelled';
    END IF;

    refund_reason := 'admin_cancelled_wallet_order';
  END IF;

  -- ---------------------------------------------------------------------------
  -- DID A WALLET PAY FOR THIS? ASK THE LEDGER
  -- ---------------------------------------------------------------------------
  -- This is the same grouping the refund loop below already performs. An order
  -- whose debits came from a wallet gets those wallets credited back; an order
  -- paid to Paystack has no debit rows here at all, so `debited_wallets` is
  -- empty and there is nothing to credit - the money was recovered by the
  -- provider, not from a wallet.
  --
  -- Previously this was decided by `order_buyer_type <> 'super_agent'`, which
  -- conflated "who bought it" with "where the money came from" and mis-handled
  -- a sub agent's wallet order once `buyer_type` began recording the real
  -- buyer. `order_buyer_type` is still SELECTed for reporting, but it no longer
  -- decides whether money moves.
  SELECT COALESCE(array_agg(DISTINCT ledger.super_agent_id), ARRAY[]::uuid[])
    INTO debited_wallets
    FROM public.super_agent_wallet_ledger AS ledger
   WHERE ledger.order_id = p_order_id
     AND ledger.entry_type = 'debit'
     AND ledger.super_agent_id IS NOT NULL;

  IF COALESCE(array_length(debited_wallets, 1), 0) = 0 THEN
    -- Paid to Paystack, not to a wallet. Cancelled, nothing credited here, and
    -- the caller is told to recover the money through the provider.
    IF p_order_type = 'agent' THEN
      UPDATE public.agent_orders
         SET status = 'cancelled'
       WHERE id = p_order_id;
    ELSE
      UPDATE public.orders
         SET status = 'cancelled'
       WHERE id = p_order_id;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_cancelled', false,
      'refunded', false,
      'refund_amount', 0,
      'buyer_type', order_buyer_type,
      'refund_note', 'normal_user_payment_requires_provider_refund'
    );
  END IF;

  -- ---------------------------------------------------------------------------
  -- Refund EVERY wallet this order debited, by the amount each one was
  -- debited - not the order amount, and not just one wallet's row.
  --
  -- Grouping by `super_agent_id` is what makes a mirrored pair come back as two
  -- independent refunds of their own recorded amounts, instead of one combined
  -- figure credited to the wrong single wallet. This is also why the sub-agent's
  -- role never has to be consulted: whatever was taken is returned to whoever it
  -- was taken from.
  -- ---------------------------------------------------------------------------
  FOR side IN
    SELECT ledger.super_agent_id,
           SUM(-ledger.amount) AS amount
      FROM public.super_agent_wallet_ledger AS ledger
     WHERE ledger.order_id = p_order_id
       AND ledger.entry_type = 'debit'
     GROUP BY ledger.super_agent_id
    HAVING SUM(-ledger.amount) > 0
  LOOP
    -- Reference is suffixed per wallet so the global UNIQUE constraint on
    -- `super_agent_wallet_ledger.reference` holds across the pair, and so a
    -- retry of the whole refund is idempotent per side rather than crediting the
    -- first wallet twice.
    refund_reference := 'admin-cancel-' || p_order_type || '-order-'
      || p_order_id::text
      || CASE WHEN side.super_agent_id = refund_wallet_owner
              THEN '' ELSE ':wallet:' || side.super_agent_id::text END;

    refund_result := public.credit_super_agent_wallet(
      side.super_agent_id,
      side.amount,
      refund_reference,
      refund_reason,
      jsonb_build_object(
        'order_id', p_order_id,
        'order_type', p_order_type,
        'refund_amount', side.amount,
        'cancelled_by', auth.uid(),
        -- 'super_agent' for the real money, 'sub_agent_mirror' for the
        -- mirrored spending power, so a reconciliation can tell the two apart
        -- on the ledger without joining back to the order.
        'wallet_side', CASE WHEN side.super_agent_id = refund_wallet_owner
                            THEN 'super_agent' ELSE 'sub_agent_mirror' END
      )
    );

    refunded_wallets := refunded_wallets
      || jsonb_build_object(
           'wallet_id', side.super_agent_id,
           'amount', side.amount,
           'balance', refund_result -> 'balance'
         );
    total_refunded := total_refunded + side.amount;
  END LOOP;

  refund_amount := total_refunded;

  IF p_order_type = 'agent' THEN
    UPDATE public.agent_orders
       SET status = 'cancelled'
     WHERE id = p_order_id;
  ELSE
    UPDATE public.orders
       SET status = 'cancelled'
     WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_cancelled', false,
    'refunded', COALESCE(refund_amount, 0) > 0,
    -- The TOTAL across every wallet refunded, which for a mirrored order is 2x
    -- the order amount. This was previously a single wallet's figure, so a
    -- caller comparing it against the order total would see a mismatch and could
    -- conclude the refund was short.
    'refund_amount', COALESCE(refund_amount, 0),
    'refunded_wallets', refunded_wallets,
    'refunded_to', refund_wallet_owner,
    'refund_reference', refund_reference,
    'buyer_type', order_buyer_type
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_admin_order(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_admin_order(text, bigint) TO service_role;

-- ---------------------------------------------------------------------------
-- Backfill the buyer_type of wallet orders written by a sub agent
-- ---------------------------------------------------------------------------
-- Optional, and reporting-only.
--
-- `verify-payment` now writes the buyer's real role, but every wallet order
-- placed before this change still carries the literal 'super_agent' even when
-- the buyer was a sub agent. Those rows are already handled correctly by the
-- refund gate above - it reads the LEDGER now, not this column - so this only
-- affects the label the admin app shows.
--
-- Restricted to rows that actually have a wallet debit, so a genuine super
-- agent's order can never be relabelled: a 'sub_agent' row is only rewritten
-- when the BUYER's authoritative profile says sub_agent, and the ledger proves
-- a wallet was involved. Both conditions together are what make it safe.
--
-- Skipped when `super_agent_wallets`-backed ledger data is unavailable, because
-- a wrong label is cosmetic but a wrong refund is not.
UPDATE public.orders o
SET buyer_type = 'sub_agent'
WHERE o.buyer_type = 'super_agent'
  AND EXISTS (
    SELECT 1
    FROM public.super_agent_wallet_ledger AS ledger
    WHERE ledger.order_id = o.id
      AND ledger.entry_type = 'debit'
  )
  AND EXISTS (
    SELECT 1
    FROM public.user_profiles AS buyer
    WHERE buyer.id = o.user_id
      AND lower(btrim(COALESCE(buyer.role, ''))) IN ('sub_agent', 'subagent', 'agent')
  );

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- 1. The function no longer gates on `buyer_type`:
--
--    SELECT p.prosrc LIKE '%order_buyer_type <> ''super_agent''%' AS still_gated,
--           p.prosrc LIKE '%debited_wallets%'                 AS ledger_gated
--      FROM pg_proc p
--     WHERE p.proname = 'cancel_admin_order';
--    Expect still_gated = false, ledger_gated = true.
--
-- 2. A sub agent's wallet order is now labelled correctly:
--
--    SELECT buyer_type, count(*)
--      FROM public.orders
--     WHERE buyer_type = 'sub_agent'
--     GROUP BY buyer_type;
--
-- 3. REGRESSION - the refund must still be a no-op for a Paystack order. Pick a
--    normal user's order with no ledger debits and cancel it; expect
--    `refund_note = 'normal_user_payment_requires_provider_refund'` and
--    `refunded = false`.
--
-- 4. `ANALYZE public.orders;` - the backfill is a bulk UPDATE.
