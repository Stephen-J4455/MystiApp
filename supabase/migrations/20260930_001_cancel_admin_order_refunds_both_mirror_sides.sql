BEGIN;

-- ===========================================================================
-- `cancel_admin_order` must refund BOTH sides of the wallet mirror
-- ===========================================================================
-- DEPENDS ON: 20260928_008 (sub-agent wallet rows), 20260928_010 (ledger-driven
--             refund of every debited wallet)
--
-- THE BUG
-- -------
-- A wallet order now writes TWO debit rows to `super_agent_wallet_ledger`:
--
--   super_agent_id = <the super agent>  reference 'wallet-order-<ref>'
--   super_agent_id = <the sub-agent>    reference 'wallet-order-<ref>:sub:<id>'
--
-- The version of `cancel_admin_order` that the admin app actually calls
-- (20260926_005) computes ONE refund:
--
--     SELECT COALESCE(SUM(-ledger.amount), 0)
--       FROM super_agent_wallet_ledger AS ledger
--      WHERE ledger.order_id = p_order_id
--        AND ledger.entry_type = 'debit'
--        AND ledger.super_agent_id = refund_wallet_owner;
--
-- For an `orders` row that `refund_wallet_owner` is `orders.user_id` - the
-- BUYER. A sub-agent placing a wallet order from their DataScreen has
-- `user_id` = themselves, so this filter matched the sub-agent's mirrored
-- debit and refunded only the MIRROR, leaving the super agent's real money
-- debited. Either way exactly one of the two sides came back, which is what
-- the report describes as "only the super agent's wallet is refunded".
--
-- WHY 010 DID NOT FIX THIS
-- ------------------------
-- Migration 20260928_010 rewrote `refund_wallet_order` to loop over every
-- debited wallet. Nothing calls that function - `cancel-admin-order` invokes
-- `cancel_admin_order`, which 010 never redefined. The fix was written against
-- an entry point the product does not use, so the defect survived it. This
-- migration fixes the function that is actually on the path.
--
-- THE FIX
-- -------
-- Derive the refund from the LEDGER alone, exactly as 010 does: group the
-- debits by `super_agent_id` and credit each wallet what it was actually
-- debited. Correct by construction - it needs no role logic, needs no
-- knowledge of the buyer, and stays correct if a third mirrored side is ever
-- added or a rollback debit of a different amount is involved.
--
-- `refund_wallet_owner` is retained only to decide WHICH ORDERS are refundable
-- (a normal user's order was paid to Paystack and has no wallet to credit).
-- It is no longer used as a ledger filter, so the ordering of the two debits
-- in the loop can no longer decide which wallet is restored.
--
-- IDEMPOTENCE
-- -----------
-- The refund reference is suffixed per wallet, so the global UNIQUE constraint
-- on `super_agent_wallet_ledger.reference` holds across a mirrored pair and a
-- retry credits neither wallet twice. The `order_status = 'cancelled'` early
-- return remains the outer guard.
-- ===========================================================================

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
  -- Which wallet an AGENT order belongs to. Retained for the agent branch's
  -- role check and for the `wallet_side` metadata label; NOT used to filter the
  -- ledger, which is now read wallet-by-wallet.
  refund_wallet_owner uuid;
  refund_amount numeric;
  refund_reference text;
  refund_result jsonb;
  refund_reason text;
  order_buyer_type text;
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

    -- Only a super-agent wallet purchase is refundable from a wallet. A normal
    -- user's order was paid to Paystack, so there is no wallet to credit - the
    -- money is recovered via a Paystack refund, which is a separate flow.
    --
    -- `buyer_type` is 'super_agent' for a wallet order, INCLUDING one placed by a
    -- sub-agent from their own wallet - `verify-payment` writes that literal on
    -- the `orders` row for every wallet purchase, because the money came out of
    -- a super agent's wallet either way. A sub-agent buying through Paystack
    -- directly takes the normal-user path below and is unaffected.
    IF order_buyer_type <> 'super_agent' THEN
      UPDATE public.orders
         SET status = 'cancelled'
       WHERE id = p_order_id;

      RETURN jsonb_build_object(
        'success', true,
        'already_cancelled', false,
        'refunded', false,
        'refund_amount', 0,
        'refund_note', 'normal_user_payment_requires_provider_refund'
      );
    END IF;

    refund_reason := 'admin_cancelled_wallet_order';
  END IF;

  -- Refund EVERY wallet this order debited, by the amount each one was
  -- debited - not the order amount, and not just one wallet's row.
  --
  -- Grouping by `super_agent_id` is what makes a mirrored pair come back as two
  -- independent refunds of their own recorded amounts, instead of one combined
  -- figure credited to the wrong single wallet. This is also why the sub-agent's
  -- role never has to be consulted: whatever was taken is returned to whoever it
  -- was taken from.
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
    'refund_reference', refund_reference
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_admin_order(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_admin_order(text, bigint) TO service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- 1. The function is the 014-refund shape, not the 005 one. There must be NO
--    line filtering the ledger by `super_agent_id = refund_wallet_owner`:
--
--    SELECT count(*) AS bad_ledger_filters
--      FROM pg_proc p
--     WHERE p.proname = 'cancel_admin_order'
--       AND p.prosrc LIKE '%ledger.super_agent_id = refund_wallet_owner%';
--    Expect 0.
--
-- 2. The status CHECK and the per-side loop both survived the rewrite:
--
--    SELECT p.prosrc LIKE '%refunded_wallets%' AS has_mirror_loop
--      FROM pg_proc p WHERE p.proname = 'cancel_admin_order';
--    Expect t.
--
-- 3. After cancelling a sub-agent's wallet order, BOTH wallets are restored.
--    Take a wallet order placed by a sub-agent (a row in `orders` with
--    `buyer_type = 'super_agent'` whose `user_id` is NOT the debited super
--    agent), record the two balances, cancel it through the admin app, then:
--
--    SELECT w.super_agent_id, w.balance
--      FROM public.super_agent_wallets w
--     WHERE w.super_agent_id IN (
--       SELECT DISTINCT super_agent_id
--         FROM public.super_agent_wallet_ledger
--        WHERE order_id = <order_id> AND entry_type = 'debit');
--    Expect both rows back at their pre-order figures, and one credit row per
--    wallet on the ledger with
--    `metadata->>'wallet_side'` in ('super_agent','sub_agent_mirror').
--
--    Also confirm the invariant still holds afterwards:
--
--    SELECT super_agent_id, balance - COALESCE(sum_sub, 0) AS headroom
--      FROM ... ;  -- super_agent.balance - sum(sub_agent.balance) >= 0
--
-- Roll this back on a throwaway order first. There is no local Postgres in this
-- workspace, so the migration has not been executed - it was judged by reading.
