BEGIN;

-- Keep the payment lifecycle distinct in storage:
--   pending    = payment has not cleared
--   processing = payment cleared; awaiting AFA review
-- Approval remains a separate administrative state.
ALTER TABLE public.afa_registrations
  DROP CONSTRAINT IF EXISTS afa_registrations_status_check;

UPDATE public.afa_registrations
SET status = CASE
  WHEN status = 'pending_payment' THEN 'pending'
  WHEN status IN ('pending_processing', 'paid', 'active') THEN 'processing'
  ELSE status
END
WHERE status IN ('pending_payment', 'pending_processing', 'paid', 'active');

ALTER TABLE public.afa_registrations
  ALTER COLUMN status SET DEFAULT 'pending',
  ADD CONSTRAINT afa_registrations_status_check
    CHECK (
      status IN (
        'pending',
        'processing',
        'approved',
        'rejected',
        'refunded',
        'cancelled'
      )
    );

COMMENT ON COLUMN public.afa_registrations.status IS
  'Payment and registration lifecycle: pending means unpaid; processing means paid and awaiting AFA review; approved means approved by the AFA.';

CREATE OR REPLACE FUNCTION public.pay_afa_registration_from_wallet(
  p_registration_id uuid,
  p_super_agent_id uuid,
  p_reference text,
  p_payer_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  registration_row public.afa_registrations%ROWTYPE;
  debit_result jsonb;
  mirror_debit_result jsonb;
  platform_amount numeric;
  markup_amount numeric;
  payer_is_owner boolean;
  payer_wallet_id uuid;
BEGIN
  SELECT * INTO registration_row
  FROM public.afa_registrations
  WHERE id = p_registration_id
  FOR UPDATE;

  IF NOT FOUND
     OR registration_row.status <> 'pending'
     OR registration_row.payment_reference <> p_reference THEN
    RAISE EXCEPTION 'AFA registration is not payable';
  END IF;

  IF registration_row.payment_method <> 'wallet' THEN
    RAISE EXCEPTION 'AFA registration is not a wallet payment';
  END IF;

  payer_wallet_id := COALESCE(p_payer_user_id, p_super_agent_id);
  payer_is_owner := (payer_wallet_id = p_super_agent_id);
  platform_amount := COALESCE(registration_row.platform_fee_amount, registration_row.fee_amount);
  IF platform_amount > registration_row.fee_amount THEN
    platform_amount := registration_row.fee_amount;
  END IF;
  markup_amount := GREATEST(registration_row.fee_amount - platform_amount, 0);

  IF NOT payer_is_owner THEN
    SELECT * INTO mirror_debit_result
    FROM public.debit_super_agent_wallet(
      payer_wallet_id,
      registration_row.fee_amount,
      p_reference || ':sub:' || payer_wallet_id::text,
      NULL,
      'afa_registration'
    );

    IF NOT (mirror_debit_result ->> 'success')::boolean THEN
      RETURN jsonb_build_object(
        'success', false,
        'reason', mirror_debit_result ->> 'reason',
        'debit', mirror_debit_result
      );
    END IF;
  END IF;

  SELECT * INTO debit_result
  FROM public.debit_super_agent_wallet(
    p_super_agent_id,
    platform_amount,
    p_reference,
    NULL,
    'afa_registration'
  );

  IF NOT (debit_result ->> 'success')::boolean THEN
    IF NOT payer_is_owner THEN
      PERFORM public.credit_super_agent_wallet(
        payer_wallet_id,
        registration_row.fee_amount,
        p_reference || ':sub-rollback:' || payer_wallet_id::text,
        'afa_registration_rollback',
        jsonb_build_object('reason', 'super_agent_debit_failed')
      );
    END IF;

    RETURN jsonb_build_object(
      'success', false,
      'reason', debit_result ->> 'reason',
      'debit', debit_result
    );
  END IF;

  UPDATE public.afa_registrations
  SET status = 'processing',
      paid_at = now(),
      updated_at = now()
  WHERE id = p_registration_id
  RETURNING * INTO registration_row;

  INSERT INTO public.afa_payment_ledger (
    registration_id, payer_user_id, amount, payment_method, payment_reference,
    beneficiary_super_agent_id, price_source, metadata
  ) VALUES (
    registration_row.id,
    registration_row.payer_user_id,
    registration_row.fee_amount,
    'wallet',
    p_reference,
    registration_row.assigned_super_agent_id,
    registration_row.price_source,
    jsonb_build_object(
      'wallet_debit', debit_result,
      'mirror_debit', mirror_debit_result,
      'currency', registration_row.currency,
      'platform_fee_amount', platform_amount,
      'agent_markup', markup_amount
    )
  ) ON CONFLICT (payment_reference) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'registration', registration_row,
    'debit', debit_result,
    'mirror_debit', mirror_debit_result,
    'platform_amount', platform_amount,
    'agent_markup', markup_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pay_afa_registration_from_wallet(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_afa_registration_from_wallet(uuid, uuid, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.pay_afa_registration_from_wallet(
  p_registration_id uuid,
  p_super_agent_id uuid,
  p_reference text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.pay_afa_registration_from_wallet(
    p_registration_id,
    p_super_agent_id,
    p_reference,
    NULL
  );
$$;

REVOKE ALL ON FUNCTION public.pay_afa_registration_from_wallet(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_afa_registration_from_wallet(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_afa_registration_payment(
  p_registration_id uuid,
  p_reference text,
  p_paystack_transaction_id text,
  p_paystack_status text,
  p_paid_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  registration_row public.afa_registrations%ROWTYPE;
  existing_ledger public.afa_payment_ledger%ROWTYPE;
BEGIN
  SELECT * INTO registration_row
  FROM public.afa_registrations
  WHERE id = p_registration_id
  FOR UPDATE;

  IF NOT FOUND OR registration_row.payment_reference <> p_reference THEN
    RAISE EXCEPTION 'AFA registration or payment reference not found';
  END IF;

  SELECT * INTO existing_ledger
  FROM public.afa_payment_ledger
  WHERE payment_reference = p_reference
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'registration', registration_row);
  END IF;

  IF registration_row.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'AFA registration is not payable';
  END IF;

  UPDATE public.afa_registrations
  SET status = 'processing',
      paystack_transaction_id = p_paystack_transaction_id,
      paystack_transaction_status = p_paystack_status,
      paid_at = COALESCE(p_paid_at, now()),
      updated_at = now()
  WHERE id = p_registration_id
  RETURNING * INTO registration_row;

  INSERT INTO public.afa_payment_ledger (
    registration_id, payer_user_id, amount, payment_method, payment_reference,
    paystack_transaction_id, beneficiary_super_agent_id, price_source, metadata
  ) VALUES (
    registration_row.id,
    registration_row.payer_user_id,
    registration_row.fee_amount,
    registration_row.payment_method,
    p_reference,
    p_paystack_transaction_id,
    CASE
      WHEN registration_row.payer_user_id IS DISTINCT FROM registration_row.assigned_super_agent_id
        THEN registration_row.assigned_super_agent_id
      ELSE NULL
    END,
    registration_row.price_source,
    jsonb_build_object(
      'id_type', registration_row.id_type,
      'currency', registration_row.currency,
      'platform_fee_amount', registration_row.platform_fee_amount
    )
  );

  RETURN jsonb_build_object('success', true, 'already_processed', false, 'registration', registration_row);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_afa_registration_payment(uuid, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_afa_registration_payment(uuid, text, text, text, timestamptz) TO service_role;

COMMIT;
