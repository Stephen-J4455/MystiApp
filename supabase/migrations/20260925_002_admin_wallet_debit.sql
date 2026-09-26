BEGIN;

-- Admin-initiated wallet debits.
--
-- The existing debit_super_agent_wallet(uuid, numeric, text, bigint, text)
-- cannot record free-text metadata, which an admin debit needs (the note and
-- who performed it). This adds a fuller implementation that also accepts
-- order_id and metadata, then repoints the original 5-arg function at it so
-- there is only one copy of the balance/ledger logic.
--
-- The original function keeps its exact signature, so existing callers in
-- verify-payment and reorder-held-agent-order resolve to it unchanged.
CREATE OR REPLACE FUNCTION public.admin_debit_super_agent_wallet(
  p_super_agent_id uuid,
  p_amount numeric,
  p_reference text,
  p_order_id bigint DEFAULT NULL,
  p_reason text DEFAULT 'sub_agent_order',
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wallet_row public.super_agent_wallets%ROWTYPE;
  existing_entry public.super_agent_wallet_ledger%ROWTYPE;
  new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Wallet debit amount must be greater than zero';
  END IF;
  IF NULLIF(trim(p_reference), '') IS NULL THEN
    RAISE EXCEPTION 'Wallet debit reference is required';
  END IF;

  SELECT * INTO existing_entry
  FROM public.super_agent_wallet_ledger
  WHERE reference = p_reference
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'balance', existing_entry.balance_after,
      'ledger_id', existing_entry.id
    );
  END IF;

  INSERT INTO public.super_agent_wallets (super_agent_id)
  VALUES (p_super_agent_id)
  ON CONFLICT (super_agent_id) DO NOTHING;

  SELECT * INTO wallet_row
  FROM public.super_agent_wallets
  WHERE super_agent_id = p_super_agent_id
  FOR UPDATE;

  -- Overdrawing is rejected rather than clamped: the wallet table has a
  -- CHECK (balance >= 0), so clamping would hide a real shortfall from the
  -- ledger and leave the admin's intent unrecorded.
  IF wallet_row.balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'insufficient_balance',
      'balance', wallet_row.balance,
      'required', p_amount
    );
  END IF;

  new_balance := wallet_row.balance - p_amount;

  UPDATE public.super_agent_wallets
  SET balance = new_balance, updated_at = now()
  WHERE super_agent_id = p_super_agent_id;

  INSERT INTO public.super_agent_wallet_ledger (
    super_agent_id,
    amount,
    balance_before,
    balance_after,
    entry_type,
    reason,
    reference,
    order_id,
    metadata
  ) VALUES (
    p_super_agent_id,
    -p_amount,
    wallet_row.balance,
    new_balance,
    'debit',
    p_reason,
    p_reference,
    p_order_id,
    COALESCE(p_metadata, '{}'::jsonb)
  );

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'balance', new_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_debit_super_agent_wallet(uuid, numeric, text, bigint, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_debit_super_agent_wallet(uuid, numeric, text, bigint, text, jsonb) TO service_role;

-- Repoint the original function at the new implementation. Signature is
-- unchanged, so existing callers are unaffected.
CREATE OR REPLACE FUNCTION public.debit_super_agent_wallet(
  p_super_agent_id uuid,
  p_amount numeric,
  p_reference text,
  p_order_id bigint DEFAULT NULL,
  p_reason text DEFAULT 'sub_agent_order'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.admin_debit_super_agent_wallet(
    p_super_agent_id,
    p_amount,
    p_reference,
    p_order_id,
    p_reason,
    '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.debit_super_agent_wallet(uuid, numeric, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.debit_super_agent_wallet(uuid, numeric, text, bigint, text) TO service_role;

COMMIT;
