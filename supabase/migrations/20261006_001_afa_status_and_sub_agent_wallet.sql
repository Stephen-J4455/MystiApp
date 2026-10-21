BEGIN;

-- ===========================================================================
-- AFA: new status vocabulary + sub-agent wallet purchases
-- ===========================================================================
--
-- TWO CHANGES, BOTH ABOUT THE SAME TABLE
--
-- 1. THE STATUS VOCABULARY
--
--    The CHECK constraint allowed six values, of which the platform actually
--    used two: `pending_payment` and `active`. Everything else existed but was
--    never written by any code path.
--
--    Those two names describe the PAYMENT, not the REGISTRATION. A user
--    reading "Pending payment" learns that their money has not gone through -
--    which, for a registration that has been paid for, is wrong and alarming.
--    The registration's real lifecycle is:
--
--      pending_processing  - paid for, awaiting the AFA's own approval
--      approved            - approved by the AFA
--
--    So the vocabulary becomes the user's vocabulary, and the two old values
--    are KEPT in the constraint rather than removed:
--
--    - `active` is the historical name for what is now `approved`. Migration
--      20260926_005 and the Paystack/wallet finalize RPCs both write it, and
--      rows written before today carry it. Deleting it from the CHECK would
--      make every historical row unreadable to a constraint, and rewriting
--      history is a lie about what was recorded.
--    - `pending_payment` is still the correct name for the state BEFORE the
--      money lands, and it is still written at insert time.
--
--    `active` is therefore MAPPED to `approved` on read, in both apps, rather
--    than being rewritten in place. The mapping lives in the UI so the two
--    surfaces cannot disagree about what a row means.
--
--    Rows are NOT migrated to `approved` in bulk. `finalize_afa_registration_payment`
--    sets `active` the moment the payment clears, which is BEFORE the AFA has
--    approved anything - so `active` genuinely means "paid, awaiting
--    processing". Renaming it to `approved` in the database would assert an
--    approval that has not happened. The status the USER sees is therefore
--    decided by the app, and the DB keeps the honest facts:
--
--      pending_payment  -> "Pending processing"   (payment not yet settled)
--      active           -> "Approved"              (payment settled + approved)
--
--    `pending_processing` and `approved` are added to the constraint so an
--    admin can set them directly from the admin app, which is where a manual
--    approval actually happens.
--
-- 2. SUB-AGENTS BUYING FROM A WALLET
--
--    `pay_afa_registration_from_wallet` debited ONE wallet: the one keyed on
--    `p_super_agent_id`, which for a super agent is their own. A sub-agent
--    paying from a wallet had no path at all.
--
--    The data-purchase path already solved this, and its shape is the one used
--    here, because it is the only shape that keeps the money honest:
--
--      - the SUPER AGENT's real wallet is drawn down by the PLATFORM's base
--        price, because that is the money the platform actually collects.
--      - the SUB-AGENT's MIRRORED wallet is drawn down by the amount THEY
--        were charged, because that is their spending power - the ceiling
--        that stops one sub-agent consuming money funded for another.
--
--    See migration 20260928_008 for why the mirror is a quota and not a second
--    pot of money. The invariant that must hold is:
--
--        super_agent.balance - sum(sub_agent.balance) >= 0
--
--    Debiting only one side would break it.
--
--    THE SUB-AGENT'S CHARGE IS THE PRICE THEY WERE QUOTED
--    (`fee_amount`), and the super agent's is the PLATFORM price
--    (`platform_fee_amount`). When a super agent has set their own sub-agent
--    price, `fee_amount` is HIGHER than `platform_fee_amount` - the difference
--    is the super agent's markup, which is their revenue, not the platform's.
--    The super agent's real wallet pays only the platform portion; their
--    markup comes out of the sub-agent's mirror. This is exactly how
--    `verify-payment` splits a data purchase, and it is why the two features
--    reconcile against each other.
--
--    WHEN `platform_fee_amount` IS NULL (a row written before that column
--    existed), it is treated as equal to `fee_amount`: there is no markup to
--    split, so the whole amount is the platform's. Backfilling the column to
--    `fee_amount` for those rows keeps this honest and makes the split
--    explicit rather than implicit.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The status vocabulary
-- ---------------------------------------------------------------------------

ALTER TABLE public.afa_registrations
  DROP CONSTRAINT IF EXISTS afa_registrations_status_check;

ALTER TABLE public.afa_registrations
  ADD CONSTRAINT afa_registrations_status_check
  CHECK (
    status IN (
      'pending_payment',    -- money has not landed yet
      'pending_processing', -- money landed, awaiting AFA approval
      'paid',               -- historical: reserved
      'active',             -- historical name for "approved"
      'approved',           -- approved by the AFA
      'rejected',
      'refunded',
      'cancelled'
    )
  );

COMMENT ON COLUMN public.afa_registrations.status IS
  'Lifecycle: pending_payment -> active/approved (payment settled) -> approved (AFA approved). pending_processing is set manually by an admin while the AFA reviews the application.';

-- The platform price column is the split between "what the platform gets" and
-- "what the super agent keeps". Rows written before it existed have no markup
-- recorded, so their platform price IS their charged price.
UPDATE public.afa_registrations
   SET platform_fee_amount = fee_amount
 WHERE platform_fee_amount IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Pay an AFA registration from a wallet, for a SUB-AGENT
-- ---------------------------------------------------------------------------
--
-- A NEW function rather than a changed signature on the old one. The old
-- `pay_afa_registration_from_wallet(uuid, uuid, text)` is called by the
-- deployed `afa-registration` edge function and by nothing else, but its
-- signature is the contract between the edge function and the database, and
-- changing it in place would leave a deployed function calling a function that
-- no longer exists - a 404 on every wallet AFA purchase until the next deploy.
--
-- The new function is additive and takes the PAYER's id explicitly, so it can
-- distinguish "the super agent paying their own wallet" from "a sub-agent
-- paying from their super agent's wallet, against their own mirror".
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
  -- The platform's share of the charge. Never more than what was charged, so
  -- a bad `platform_fee_amount` cannot take more money than the payer paid.
  platform_amount numeric;
  -- The super agent's markup on this registration. Never negative.
  markup_amount numeric;
  -- True when the payer is the wallet owner themselves (a super agent paying
  -- from their own wallet), so there is no mirror to move.
  payer_is_owner boolean;
  payer_wallet_id uuid;
BEGIN
  SELECT * INTO registration_row
  FROM public.afa_registrations
  WHERE id = p_registration_id
  FOR UPDATE;

  IF NOT FOUND
     OR registration_row.status <> 'pending_payment'
     OR registration_row.payment_reference <> p_reference THEN
    RAISE EXCEPTION 'AFA registration is not payable';
  END IF;

  IF registration_row.payment_method <> 'wallet' THEN
    RAISE EXCEPTION 'AFA registration is not a wallet payment';
  END IF;

  -- The payer defaults to the wallet owner. When a sub-agent pays, the caller
  -- passes the sub-agent's id explicitly.
  payer_wallet_id := COALESCE(p_payer_user_id, p_super_agent_id);
  payer_is_owner := (payer_wallet_id = p_super_agent_id);

  -- The split. `platform_fee_amount` is the platform's base price and
  -- `fee_amount` is what the payer was charged; the difference is the super
  -- agent's markup.
  platform_amount := COALESCE(registration_row.platform_fee_amount, registration_row.fee_amount);
  IF platform_amount > registration_row.fee_amount THEN
    platform_amount := registration_row.fee_amount;
  END IF;
  markup_amount := registration_row.fee_amount - platform_amount;
  IF markup_amount < 0 THEN
    markup_amount := 0;
  END IF;

  -- THE MIRROR IS DEBITED FIRST.
  --
  -- It is the tighter constraint: the sub-agent's spending power is what
  -- limits this purchase, and the super agent's real balance may well be
  -- larger. Debiting it first means a purchase that the sub-agent cannot
  -- afford is refused before any real money moves - the same ordering
  -- `verify-payment` uses for data purchases, and for the same reason.
  --
  -- The mirror moves by the FULL charged amount (`fee_amount`), because that
  -- is the sub-agent's spending power being consumed. The super agent's real
  -- wallet moves by the platform portion only.
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

  -- Side 1: the super agent's REAL money, at the platform's price.
  SELECT * INTO debit_result
  FROM public.debit_super_agent_wallet(
    p_super_agent_id,
    platform_amount,
    p_reference,
    NULL,
    'afa_registration'
  );

  IF NOT (debit_result ->> 'success')::boolean THEN
    -- The mirror has already been debited, so it is now UNDER-spent relative
    -- to the real balance. That is the safe direction to be wrong in - the
    -- sub-agent has spending power they cannot use, rather than the platform
    -- owing money it does not hold - but it must be repaired. The rollback
    -- uses a DIFFERENT reference from the debit, so it is not swallowed by
    -- `credit_super_agent_wallet`'s existing-reference guard.
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

  -- The registration is PAID. `active` is the value the deployed finalize RPC
  -- writes and the one the admin app and the customer app both already know
  -- how to read; `approved` is what an admin sets manually once the AFA has
  -- actually approved the application. Writing `approved` here would assert an
  -- approval that has not happened.
  UPDATE public.afa_registrations
  SET status = 'active',
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

-- The 3-arg form is kept working: it is what an older deployed edge function
-- calls. It resolves to the 4-arg one with no payer, i.e. the wallet owner
-- pays for themselves - exactly the super-agent-only behaviour it had.
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

-- ---------------------------------------------------------------------------
-- 3. `finalize_afa_registration_payment` - keep the status vocabulary honest
-- ---------------------------------------------------------------------------
--
-- The Paystack path sets `active` the moment the payment clears. That is the
-- same "paid, awaiting processing" fact the wallet path records, so it stays
-- `active` - but the payable-state guard has to know about the new values, or
-- a registration an admin has manually set to `approved` could never be
-- re-finalised.
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

  IF registration_row.status NOT IN ('pending_payment', 'paid', 'active', 'pending_processing') THEN
    RAISE EXCEPTION 'AFA registration is not payable';
  END IF;

  UPDATE public.afa_registrations
  SET status = 'active',
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
