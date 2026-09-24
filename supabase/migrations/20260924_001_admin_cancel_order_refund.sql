BEGIN;

-- Cancel an order and, for sub-agent orders, restore any super-agent wallet
-- debits that were recorded for that order. The function is idempotent because
-- the refund ledger reference is derived from the order id.
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
  refund_amount numeric;
  refund_reference text;
  refund_result jsonb;
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

    SELECT COALESCE(SUM(-ledger.amount), 0)
      INTO refund_amount
      FROM public.super_agent_wallet_ledger AS ledger
     WHERE ledger.order_id = p_order_id
       AND ledger.entry_type = 'debit'
       AND ledger.super_agent_id = order_super_agent_id;

    refund_reference := 'admin-cancel-agent-order-' || p_order_id::text;

    IF refund_amount > 0 AND order_super_agent_id IS NOT NULL THEN
      refund_result := public.credit_super_agent_wallet(
        order_super_agent_id,
        refund_amount,
        refund_reference,
        'admin_cancelled_agent_order',
        jsonb_build_object(
          'order_id', p_order_id,
          'order_type', 'agent',
          'refund_amount', refund_amount
        )
      );
    END IF;

    UPDATE public.agent_orders
       SET status = 'cancelled'
     WHERE id = p_order_id;
  ELSE
    SELECT status
      INTO order_status
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

    UPDATE public.orders
       SET status = 'cancelled'
     WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_cancelled', false,
    'refunded', COALESCE(refund_amount, 0) > 0,
    'refund_amount', COALESCE(refund_amount, 0),
    'refund_result', refund_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_admin_order(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_admin_order(text, bigint) TO service_role;

COMMIT;
