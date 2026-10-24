BEGIN;

CREATE OR REPLACE FUNCTION public.admin_adjust_sub_agent_wallet(
  p_sub_agent_id uuid,
  p_amount numeric,
  p_direction text,
  p_reference text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner_id uuid;
  sub_balance numeric;
  owner_balance numeric;
  new_sub_balance numeric;
  new_owner_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Wallet adjustment amount must be greater than zero';
  END IF;
  IF p_direction IS NULL OR p_direction NOT IN ('credit', 'debit') THEN
    RAISE EXCEPTION 'Wallet adjustment direction must be credit or debit';
  END IF;
  IF NULLIF(TRIM(p_reference), '') IS NULL THEN
    RAISE EXCEPTION 'Wallet adjustment reference is required';
  END IF;

  SELECT profile.super_agent_id
    INTO owner_id
    FROM public.user_profiles AS profile
   WHERE profile.id = p_sub_agent_id
     AND LOWER(TRIM(COALESCE(profile.role, ''))) IN ('sub_agent', 'subagent');

  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'Selected account is not an assigned sub-agent';
  END IF;
  IF owner_id = p_sub_agent_id THEN
    RAISE EXCEPTION 'Sub-agent cannot own their own mirrored wallet';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.user_profiles AS profile
     WHERE profile.id = owner_id
       AND LOWER(TRIM(COALESCE(profile.role, ''))) IN ('super_agent', 'superagent')
  ) THEN
    RAISE EXCEPTION 'The assigned Super Agent profile is unavailable';
  END IF;

  IF p_direction = 'credit' AND EXISTS (
    SELECT 1
      FROM public.super_agent_wallet_ledger
     WHERE reference IN (p_reference || ':owner', p_reference || ':sub')
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.super_agent_wallet_ledger
       WHERE reference = p_reference || ':owner'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.super_agent_wallet_ledger
       WHERE reference = p_reference || ':sub'
    ) THEN
      RAISE EXCEPTION 'Wallet credit was only partially recorded';
    END IF;
    SELECT balance_after INTO owner_balance
      FROM public.super_agent_wallet_ledger
     WHERE reference = p_reference || ':owner';
    SELECT balance_after INTO sub_balance
      FROM public.super_agent_wallet_ledger
     WHERE reference = p_reference || ':sub';
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'balance', sub_balance,
      'super_agent_balance', owner_balance
    );
  ELSIF p_direction = 'debit' AND EXISTS (
    SELECT 1
      FROM public.super_agent_wallet_ledger
     WHERE reference = p_reference || ':sub'
  ) THEN
    SELECT balance_after INTO sub_balance
      FROM public.super_agent_wallet_ledger
     WHERE reference = p_reference || ':sub';
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'balance', sub_balance
    );
  END IF;

  INSERT INTO public.super_agent_wallets (super_agent_id)
  VALUES (owner_id), (p_sub_agent_id)
  ON CONFLICT (super_agent_id) DO NOTHING;

  PERFORM wallet.super_agent_id
    FROM public.super_agent_wallets AS wallet
   WHERE wallet.super_agent_id IN (owner_id, p_sub_agent_id)
   ORDER BY wallet.super_agent_id
   FOR UPDATE;

  IF p_direction = 'credit' AND EXISTS (
    SELECT 1
      FROM public.super_agent_wallet_ledger
     WHERE reference IN (p_reference || ':owner', p_reference || ':sub')
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.super_agent_wallet_ledger
       WHERE reference = p_reference || ':owner'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.super_agent_wallet_ledger
       WHERE reference = p_reference || ':sub'
    ) THEN
      RAISE EXCEPTION 'Wallet credit was only partially recorded';
    END IF;
    SELECT balance_after INTO owner_balance
      FROM public.super_agent_wallet_ledger
     WHERE reference = p_reference || ':owner';
    SELECT balance_after INTO sub_balance
      FROM public.super_agent_wallet_ledger
     WHERE reference = p_reference || ':sub';
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'balance', sub_balance,
      'super_agent_balance', owner_balance
    );
  ELSIF p_direction = 'debit' AND EXISTS (
    SELECT 1
      FROM public.super_agent_wallet_ledger
     WHERE reference = p_reference || ':sub'
  ) THEN
    SELECT balance_after INTO sub_balance
      FROM public.super_agent_wallet_ledger
     WHERE reference = p_reference || ':sub';
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'balance', sub_balance
    );
  END IF;

  SELECT wallet.balance
    INTO owner_balance
    FROM public.super_agent_wallets AS wallet
   WHERE wallet.super_agent_id = owner_id;

  SELECT wallet.balance
    INTO sub_balance
    FROM public.super_agent_wallets AS wallet
   WHERE wallet.super_agent_id = p_sub_agent_id;

  IF p_direction = 'debit' THEN
    IF sub_balance < p_amount THEN
      RETURN jsonb_build_object(
        'success', false,
        'reason', 'insufficient_balance',
        'balance', sub_balance,
        'required', p_amount
      );
    END IF;

    new_sub_balance := sub_balance - p_amount;
    UPDATE public.super_agent_wallets
       SET balance = new_sub_balance, updated_at = now()
     WHERE super_agent_id = p_sub_agent_id;

    INSERT INTO public.super_agent_wallet_ledger (
      super_agent_id, amount, balance_before, balance_after, entry_type,
      reason, reference, metadata
    ) VALUES (
      p_sub_agent_id, -p_amount, sub_balance, new_sub_balance, 'debit',
      'admin_wallet_debit', p_reference || ':sub',
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('wallet_side', 'sub_agent')
    );

    RETURN jsonb_build_object(
      'success', true,
      'balance', new_sub_balance,
      'super_agent_balance', owner_balance
    );
  END IF;

  new_owner_balance := owner_balance + p_amount;
  new_sub_balance := sub_balance + p_amount;
  UPDATE public.super_agent_wallets
     SET balance = CASE
       WHEN super_agent_id = owner_id THEN new_owner_balance
       ELSE new_sub_balance
     END,
     updated_at = now()
   WHERE super_agent_id IN (owner_id, p_sub_agent_id);

  INSERT INTO public.super_agent_wallet_ledger (
    super_agent_id, amount, balance_before, balance_after, entry_type,
    reason, reference, metadata
  ) VALUES
    (
      owner_id, p_amount, owner_balance, new_owner_balance, 'credit',
      'admin_wallet_topup', p_reference || ':owner',
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('wallet_side', 'super_agent')
    ),
    (
      p_sub_agent_id, p_amount, sub_balance, new_sub_balance, 'credit',
      'admin_wallet_topup', p_reference || ':sub',
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('wallet_side', 'sub_agent')
    );

  RETURN jsonb_build_object(
    'success', true,
    'balance', new_sub_balance,
    'super_agent_balance', new_owner_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_sub_agent_wallet(uuid, numeric, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_sub_agent_wallet(uuid, numeric, text, text, jsonb)
  TO service_role;

COMMIT;
