BEGIN;

-- ===========================================================================
-- 1. Tiered AFA base prices
-- ===========================================================================
-- The platform previously had a single global `afa_registration_settings.
-- registration_fee`, so a sub-agent's AFA payment could only ever be charged
-- whatever the admin set for everyone. That leaves no room for a super agent
-- to earn from their own sub-agents' registrations.
--
-- This adds an independent per-tier base price so the chain is:
--   platform sets  -> price charged to a super agent registering someone
--   super agent sets -> price charged to THEIR sub-agent registering someone
--
-- The two are configured separately, exactly like `api_cost_settings.audience`
-- (super_agent | normal_user) and `payment_charge_settings`. A NULL
-- `super_agent_base_price` means "fall back to the global fee", so existing
-- rows keep working with no backfill.
--
-- NOTE ON NULLABILITY: these are nullable on purpose. `resolve_afa_base_price`
-- treats NULL as "not configured" and falls back, which is what lets this
-- migration land without forcing a decision on what the platform's super-agent
-- price should be.

ALTER TABLE public.afa_registration_settings
  ADD COLUMN IF NOT EXISTS super_agent_base_price numeric
    CHECK (super_agent_base_price IS NULL OR super_agent_base_price >= 0),
  ADD COLUMN IF NOT EXISTS sub_agent_base_price numeric
    CHECK (sub_agent_base_price IS NULL OR sub_agent_base_price >= 0);

COMMENT ON COLUMN public.afa_registration_settings.super_agent_base_price IS
  'Platform-set price charged when a SUPER AGENT registers someone. NULL = fall back to registration_fee.';
COMMENT ON COLUMN public.afa_registration_settings.sub_agent_base_price IS
  'Price a SUPER AGENT sets for their own sub-agents. NULL = fall back to registration_fee.';

-- Super agents must be able to READ the settings row (they need to see what
-- their own base price currently is) but only the PLATFORM may WRITE the
-- `sub_agent_base_price` - otherwise any super agent could rewrite the price
-- for every other super agent's sub-agents.
--
-- The existing afa_settings_admin_read/admin_update policies already cover
-- platform admins. This adds the super-agent read leg only.
DROP POLICY IF EXISTS afa_settings_super_agent_read ON public.afa_registration_settings;
CREATE POLICY afa_settings_super_agent_read ON public.afa_registration_settings
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') IN ('SuperAgent', 'superagent', 'super_agent')
    OR (auth.jwt() -> 'app_metadata' ->> 'role') IN ('SuperAgent', 'superagent', 'super_agent')
  );

-- Per-super-agent AFA price, set by that super agent for their own sub-agents.
CREATE TABLE IF NOT EXISTS public.super_agent_afa_pricing (
  super_agent_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- What ONE of this super agent's sub-agents is charged.
  sub_agent_base_price numeric NOT NULL CHECK (sub_agent_base_price >= 0),
  currency text NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS'),
  is_enabled boolean NOT NULL DEFAULT true,
  notes text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.super_agent_afa_pricing IS
  'Per-super-agent AFA base price charged to that super agent''s sub-agents. Overrides the platform default when present and enabled.';

ALTER TABLE public.super_agent_afa_pricing ENABLE ROW LEVEL SECURITY;

-- A super agent may manage ONLY their own row. Scoped with USING on both
-- commands so an UPDATE cannot retarget the row to a different owner.
DROP POLICY IF EXISTS super_agent_afa_pricing_owner_all ON public.super_agent_afa_pricing;
CREATE POLICY super_agent_afa_pricing_owner_all ON public.super_agent_afa_pricing
  FOR ALL TO authenticated
  USING (super_agent_id = auth.uid())
  WITH CHECK (super_agent_id = auth.uid());

-- The admin app reads these with the anon key through RLS, so it needs a
-- platform-admin leg as well.
DROP POLICY IF EXISTS super_agent_afa_pricing_admin_all ON public.super_agent_afa_pricing;
CREATE POLICY super_agent_afa_pricing_admin_all ON public.super_agent_afa_pricing
  FOR ALL TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'Admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'Admin'
  )
  WITH CHECK (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'Admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'Admin'
  );

-- Resolve the price ONE registration should be charged, plus where it came
-- from so the UI and ledger can explain the number.
--
-- p_payer_is_super_agent - the PAYER is a super agent (platform tier price).
-- p_payer_super_agent_id - the payer's own super agent, when the payer is a
--                           sub-agent (that super agent's price applies).
CREATE OR REPLACE FUNCTION public.resolve_afa_base_price(
  p_payer_is_super_agent boolean,
  p_payer_super_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  base_price numeric,
  price_source text,
  currency text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  settings_row public.afa_registration_settings%ROWTYPE;
  agent_pricing public.super_agent_afa_pricing%ROWTYPE;
BEGIN
  SELECT * INTO settings_row
  FROM public.afa_registration_settings
  WHERE id = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::numeric, 'missing_settings'::text, 'GHS'::text;
    RETURN;
  END IF;

  IF p_payer_is_super_agent THEN
    -- Platform-set price for super agents, falling back to the global fee.
    IF settings_row.super_agent_base_price IS NOT NULL THEN
      RETURN QUERY SELECT
        settings_row.super_agent_base_price,
        'platform_super_agent'::text,
        settings_row.currency;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      settings_row.registration_fee,
      'platform_default'::text,
      settings_row.currency;
    RETURN;
  END IF;

  -- Payer is a sub-agent: their super agent's price wins, if one is set.
  IF p_payer_super_agent_id IS NOT NULL THEN
    SELECT * INTO agent_pricing
    FROM public.super_agent_afa_pricing
    WHERE super_agent_id = p_payer_super_agent_id
      AND is_enabled = true;

    IF FOUND THEN
      RETURN QUERY SELECT
        agent_pricing.sub_agent_base_price,
        'super_agent_override'::text,
        agent_pricing.currency;
      RETURN;
    END IF;
  END IF;

  IF settings_row.sub_agent_base_price IS NOT NULL THEN
    RETURN QUERY SELECT
      settings_row.sub_agent_base_price,
      'platform_sub_agent'::text,
      settings_row.currency;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    settings_row.registration_fee,
    'platform_default'::text,
    settings_row.currency;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_afa_base_price(boolean, uuid) FROM PUBLIC;
-- The afa-registration edge function is service_role, but a super agent's
-- own settings screen reads this through the anon client, so authenticated
-- users need EXECUTE.
GRANT EXECUTE ON FUNCTION public.resolve_afa_base_price(boolean, uuid) TO service_role, authenticated;

-- Snapshot the price ONTO the registration, alongside the global fee.
--
-- The existing `fee_amount` column is CHECK-constrained to >= 0 and is what
-- the Paystack verify path compares the charged amount against. For a
-- sub-agent paying a super agent's price, the CHARGED amount may now exceed
-- the platform's `registration_fee`, so the two must be recorded separately or
-- reconciliation breaks.
ALTER TABLE public.afa_registrations
  ADD COLUMN IF NOT EXISTS platform_fee_amount numeric
    CHECK (platform_fee_amount IS NULL OR platform_fee_amount >= 0),
  ADD COLUMN IF NOT EXISTS price_source text;

COMMENT ON COLUMN public.afa_registrations.platform_fee_amount IS
  'The platform base price at time of purchase. fee_amount is what the payer was actually charged; these differ when a super agent override applied.';
COMMENT ON COLUMN public.afa_registrations.price_source IS
  'Provenance of fee_amount: platform_default | platform_super_agent | platform_sub_agent | super_agent_override.';

-- Backfill so historical rows are not NULL.
UPDATE public.afa_registrations
   SET platform_fee_amount = fee_amount
 WHERE platform_fee_amount IS NULL;

-- Record who actually received the money when a super agent override applied,
-- so the platform can tell "paid to Paystack" from "paid to a super agent".
ALTER TABLE public.afa_payment_ledger
  ADD COLUMN IF NOT EXISTS beneficiary_super_agent_id uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS price_source text;

COMMENT ON COLUMN public.afa_payment_ledger.beneficiary_super_agent_id IS
  'Super agent entitled to this payment. Set when a sub-agent paid their own super agent''s AFA price rather than paying the platform.';

-- Re-point the finalize RPC so the ledger row carries the price provenance and
-- the beneficiary.
--
-- The beneficiary is DERIVED here rather than passed in, so it cannot be
-- spoofed by a crafted edge-function call: it is the registration's own
-- `assigned_super_agent_id`, and only recorded when that agent actually had an
-- active Paystack subaccount at purchase time (which is what routed the money).
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

  IF registration_row.status NOT IN ('pending_payment', 'paid', 'active') THEN
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
    registration_id, payer_user_id, amount, payment_method,
    payment_reference, paystack_transaction_id,
    beneficiary_super_agent_id, price_source, metadata
  ) VALUES (
    registration_row.id,
    registration_row.payer_user_id,
    registration_row.fee_amount,
    registration_row.payment_method,
    p_reference,
    p_paystack_transaction_id,
    -- Only a sub-agent's payment has a beneficiary. A super agent registering
    -- someone pays the platform, so there is nobody to credit.
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

-- ===========================================================================
-- 2. Refund wallet-funded orders on cancel
-- ===========================================================================
-- `cancel_admin_order` only refunded `agent_orders`, because that is the only
-- table that recorded a wallet debit. But a super agent buying data for their
-- own Data Screen writes a row to `orders` (buyer_type = 'super_agent') AND
-- debits their wallet via `debit_super_agent_wallet` with
-- reason = 'super_agent_package_purchase' and that `orders.id` as `order_id`.
--
-- Cancelling that order left the debit in place: the super agent paid for
-- data that was never delivered and had no way to get the money back short of
-- a manual admin debit.
--
-- This replaces the function so BOTH order types refund. The refund is derived
-- from the ledger rather than from the order amount, which is what makes it
-- correct when the wallet was only partially debited and what makes it
-- idempotent - the reference is derived from the order id, so a repeated
-- cancel is a no-op at the ledger's UNIQUE reference.

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
  -- Which wallet the debit belongs to. For an agent order that is the order's
  -- super_agent_id; for a wallet-funded order it is the buyer themselves.
  refund_wallet_owner uuid;
  refund_amount numeric;
  refund_reference text;
  refund_result jsonb;
  refund_reason text;
  order_buyer_type text;
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

    -- Only a super-agent wallet purchase is refundable. A normal user's order
    -- was paid to Paystack, so there is no wallet to credit - the money is
    -- recovered via a Paystack refund, which is a separate flow.
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

  -- Refund whatever was ACTUALLY debited for this order, not the order
  -- amount. Keyed on order_id + debit so a wallet-funded order refunds too,
  -- and so a partially-debited order returns only what left the wallet.
  SELECT COALESCE(SUM(-ledger.amount), 0)
    INTO refund_amount
    FROM public.super_agent_wallet_ledger AS ledger
   WHERE ledger.order_id = p_order_id
     AND ledger.entry_type = 'debit'
     AND ledger.super_agent_id = refund_wallet_owner;

  refund_reference := 'admin-cancel-' || p_order_type || '-order-' || p_order_id::text;

  IF refund_amount > 0 AND refund_wallet_owner IS NOT NULL THEN
    refund_result := public.credit_super_agent_wallet(
      refund_wallet_owner,
      refund_amount,
      refund_reference,
      refund_reason,
      jsonb_build_object(
        'order_id', p_order_id,
        'order_type', p_order_type,
        'refund_amount', refund_amount,
        'cancelled_by', auth.uid()
      )
    );
  END IF;

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
    'refund_amount', COALESCE(refund_amount, 0),
    'refunded_to', refund_wallet_owner,
    'refund_result', refund_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_admin_order(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_admin_order(text, bigint) TO service_role;

COMMIT;
