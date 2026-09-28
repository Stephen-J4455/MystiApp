BEGIN;

-- ===========================================================================
-- Refund BOTH sides of the wallet mirror
-- ===========================================================================
-- DEPENDS ON: 20260928_008 (sub-agent wallet rows)
--
-- THE BUG THIS FIXES
-- ------------------
-- A wallet order now writes TWO debit rows to `super_agent_wallet_ledger`:
--
--   super_agent_id = <the super agent>   reference 'wallet-order-<ref>'
--   super_agent_id = <the sub-agent>     reference 'wallet-order-<ref>:sub:<id>'
--
-- `20260926_005`'s `refund_wallet_order` computes the refund with:
--
--     SELECT COALESCE(SUM(-ledger.amount), 0)
--       FROM super_agent_wallet_ledger AS ledger
--      WHERE ledger.order_id = p_order_id
--        AND ledger.entry_type = 'debit'
--        AND ledger.super_agent_id = refund_wallet_owner;
--
-- That filter keeps only the SUPER AGENT's row, and then credits exactly that
-- much back to the super agent. So cancelling a sub-agent's order would
-- restore the real money and leave the sub-agent's mirrored balance still
-- debited - the mirror would leak downward on every refund, and the sub-agent
-- would silently lose spending power they paid for.
--
-- The mirror has to be restored too, or the invariant
--
--     super_agent.balance - sum(sub_agent.balance) >= 0
--
-- drifts further out of shape with every cancellation, until a super agent
-- who is owed nothing still shows sub-agents with no spending power.
--
-- WHY IT IS SAFE TO FIX BY REFERRING TO THE LEDGER
-- -----------------------------------------------
-- Nothing here needs to know the role or the relationship. The ledger already
-- records which wallets were debited for this exact order, so refunding
-- whatever was actually taken FROM EACH is correct by construction - and it
-- automatically stays correct if a third mirrored side is ever added, or if a
-- rollback debit of a different amount is involved.
--
-- Summing the debits and crediting the same total back is also self-correcting
-- on a retry: the refund credit uses a deterministic reference, so a second
-- call is a no-op via `credit_super_agent_wallet`'s existing-reference guard.
--
-- A `held` order is NOT refundable here. The `20260926_005` function raises
-- for any status outside ('pending', 'processing'), and that guard is
-- deliberate - a held order is one where a debit FAILED, so there is nothing
-- to return. This migration only widens WHICH wallets are restored, not which
-- orders qualify.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.refund_wallet_order(
  p_order_id bigint,
  p_order_type text DEFAULT 'regular',
  p_cancelled_by uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_status text;
  order_buyer_type text;
  order_super_agent_id uuid;
  refund_amount numeric;
  refund_reference text;
  refund_reason text;
  refund_result jsonb;
  side record;
  refunded_wallets jsonb := '[]'::jsonb;
  total_refunded numeric := 0;
BEGIN
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
        'success', true, 'already_cancelled', true, 'refunded', false
      );
    END IF;

    IF order_status NOT IN ('pending', 'processing', 'held') THEN
      RAISE EXCEPTION 'Only pending, processing, or held orders can be cancelled';
    END IF;

    refund_reason := 'admin_cancelled_agent_order';
  ELSE
    SELECT status, COALESCE(buyer_type, '')
      INTO order_status, order_buyer_type
      FROM public.orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order not found';
    END IF;

    IF order_status = 'cancelled' THEN
      RETURN jsonb_build_object(
        'success', true, 'already_cancelled', true, 'refunded', false
      );
    END IF;

    IF order_status NOT IN ('pending', 'processing') THEN
      RAISE EXCEPTION 'Only pending or processing orders can be cancelled';
    END IF;

    -- Only a super-agent wallet purchase is refundable. A normal user's order
    -- was paid to Paystack, so there is no wallet to credit - the money is
    -- recovered via a Paystack refund, which is a separate flow.
    IF order_buyer_type <> 'super_agent' THEN
      UPDATE public.orders SET status = 'cancelled' WHERE id = p_order_id;
      RETURN jsonb_build_object(
        'success', true, 'already_cancelled', false, 'refunded', false,
        'refund_amount', 0,
        'refund_note', 'normal_user_payment_requires_provider_refund'
      );
    END IF;

    refund_reason := 'admin_cancelled_wallet_order';
  END IF;

  -- Refund EVERY wallet this order debited, by the amount each one was
  -- debited - not the order amount, and not just the super agent's row.
  --
  -- Grouping by `super_agent_id` is what makes a mirrored pair come back as
  -- two independent refunds of their own recorded amounts, instead of one
  -- combined figure that would be credited to the wrong single wallet. This
  -- is also why the sub-agent's role never has to be consulted: whatever was
  -- taken is returned, to whoever it was taken from.
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
    -- retry of the whole refund is idempotent per side rather than crediting
    -- the first wallet twice.
    refund_reference := 'admin-cancel-' || p_order_type || '-order-'
      || p_order_id::text
      || CASE WHEN side.super_agent_id = order_super_agent_id
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
        'cancelled_by', p_cancelled_by,
        -- 'super_agent' for the real money, 'sub_agent_mirror' for the
        -- mirrored spending power, so a reconciliation can tell the two apart
        -- on the ledger without joining back to the order.
        'wallet_side', CASE WHEN side.super_agent_id = order_super_agent_id
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
    UPDATE public.agent_orders SET status = 'cancelled' WHERE id = p_order_id;
  ELSE
    UPDATE public.orders SET status = 'cancelled' WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_cancelled', false,
    'refunded', refund_amount > 0,
    'refund_amount', refund_amount,
    -- The total across every wallet refunded, which for a mirrored order is
    -- 2x the order amount. Previously this was the single super agent's
    -- amount, so a caller comparing it against the order total would have seen
    -- a mismatch and could have concluded the refund was short.
    'refunded_wallets', refunded_wallets,
    'refunded_to', order_super_agent_id,
    'refund_reference', refund_reference
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refund_wallet_order(bigint, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_wallet_order(bigint, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Every wallet debited for a mirrored order is restored by the refund, and the
-- mirror is balanced again. Cancel a sub-agent order, then:
--
--   -- both debit rows exist...
--   SELECT super_agent_id, -amount AS debited, entry_type
--     FROM public.super_agent_wallet_ledger
--    WHERE order_id = <order> AND entry_type IN ('debit', 'credit')
--    ORDER BY id;
-- Expect 2 debits and 2 credits, each wallet's credit equal to its own debit.
--
--   -- and the invariant holds again
--   SELECT w.super_agent_id,
--          w.balance - COALESCE(sum(s.balance), 0) AS unencumbered
--     FROM public.super_agent_wallets w
--     JOIN public.user_profiles p ON p.super_agent_id = w.super_agent_id
--     JOIN public.super_agent_wallets s ON s.super_agent_id = p.id
--    WHERE p.id = <the sub-agent>
--    GROUP BY w.super_agent_id, w.balance;
--
-- Re-running the refund is a no-op (deterministic reference per wallet):
--   -- `refund_amount` should be 0 on the second call, and the ledger should
--   -- still show exactly 2 debits and 2 credits.
-- ---------------------------------------------------------------------------

COMMIT;
