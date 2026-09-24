BEGIN;

-- Central analytics calculation. The public wrapper below enforces the
-- caller's role; this private helper only accepts an already-validated scope.
CREATE OR REPLACE FUNCTION public.calculate_business_analytics(
  p_super_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  effective_super_agent_id uuid := p_super_agent_id;
  result jsonb;
BEGIN
  WITH
  agent_transactions AS (
    SELECT
      pt.id,
      pt.super_agent_id,
      pt.user_id AS agent_id,
      pt.created_at,
      pt.gross_amount,
      pt.base_amount,
      pt.agent_markup,
      pt.transaction_fee,
      pt.super_agent_amount,
      ao.status AS order_status,
      CASE
        WHEN ao.status NOT IN ('cancelled', 'failed') THEN 1
        ELSE 0
      END AS is_active
    FROM public.payment_transactions AS pt
    INNER JOIN public.agent_orders AS ao
      ON ao.id = pt.order_id
    WHERE pt.order_type = 'agent'
      AND (
        effective_super_agent_id IS NULL
        OR pt.super_agent_id = effective_super_agent_id
      )
  ),
  super_agent_purchases AS (
    SELECT
      pt.id,
      pt.user_id AS super_agent_id,
      pt.created_at,
      pt.gross_amount,
      pt.base_amount,
      pt.transaction_fee,
      o.status AS order_status,
      CASE
        WHEN o.status NOT IN ('cancelled', 'failed') THEN 1
        ELSE 0
      END AS is_active
    FROM public.payment_transactions AS pt
    INNER JOIN public.orders AS o
      ON o.id = pt.order_id
    WHERE pt.order_type = 'regular'
      AND pt.payment_reference LIKE 'wallet_%'
      AND EXISTS (
        SELECT 1
        FROM public.super_agent_wallets AS buyer_wallet
        WHERE buyer_wallet.super_agent_id = pt.user_id
      )
      AND (
        effective_super_agent_id IS NULL
        OR pt.user_id = effective_super_agent_id
      )
  ),
  afa_entries AS (
    SELECT
      ledger.id,
      ledger.created_at,
      ledger.entry_type,
      ledger.payment_method,
      registration.assigned_super_agent_id AS super_agent_id,
      CASE
        WHEN ledger.entry_type = 'refund' THEN -ledger.amount
        ELSE ledger.amount
      END AS signed_amount
    FROM public.afa_payment_ledger AS ledger
    INNER JOIN public.afa_registrations AS registration
      ON registration.id = ledger.registration_id
    WHERE (
      effective_super_agent_id IS NULL
      OR registration.assigned_super_agent_id = effective_super_agent_id
    )
  ),
  wallet_balances AS (
    SELECT
      COALESCE(SUM(balance), 0) AS total_balance,
      COUNT(*) FILTER (WHERE balance > 0) AS funded_wallet_count
    FROM public.super_agent_wallets
    WHERE effective_super_agent_id IS NULL
       OR super_agent_id = effective_super_agent_id
  ),
  wallet_movements AS (
    SELECT ledger.entry_type, ledger.amount, ledger.created_at
    FROM public.super_agent_wallet_ledger AS ledger
    WHERE effective_super_agent_id IS NULL
       OR ledger.super_agent_id = effective_super_agent_id
  ),
  wallet_funding AS (
    SELECT topup.amount, topup.created_at
    FROM public.wallet_topups AS topup
    WHERE topup.status = 'success'
      AND EXISTS (
        SELECT 1
        FROM public.super_agent_wallets AS funder_wallet
        WHERE funder_wallet.super_agent_id = topup.agent_id
      )
      AND (
        effective_super_agent_id IS NULL
        OR topup.agent_id = effective_super_agent_id
      )
  ),
  sub_agent_totals AS (
    SELECT
      atx.agent_id,
      atx.super_agent_id,
      COALESCE(agent_profile.business_name, '') AS business_name,
      COALESCE(agent_profile.full_name, '') AS full_name,
      COALESCE(agent.email, '') AS email,
      COUNT(*) FILTER (WHERE atx.is_active = 1) AS transaction_count,
      COALESCE(SUM(atx.gross_amount) FILTER (WHERE atx.is_active = 1), 0) AS gross_sales,
      COALESCE(SUM(atx.base_amount) FILTER (WHERE atx.is_active = 1), 0) AS base_cost,
      COALESCE(SUM(atx.agent_markup) FILTER (WHERE atx.is_active = 1), 0) AS markup_earnings,
      COALESCE(SUM(atx.transaction_fee) FILTER (WHERE atx.is_active = 1), 0) AS platform_fees,
      COALESCE(SUM(atx.super_agent_amount) FILTER (WHERE atx.is_active = 1), 0) AS super_agent_revenue
    FROM agent_transactions AS atx
    LEFT JOIN public.user_profiles AS agent_profile
      ON agent_profile.id = atx.agent_id
    LEFT JOIN auth.users AS agent
      ON agent.id = atx.agent_id
    WHERE atx.agent_id IS NOT NULL
    GROUP BY
      atx.agent_id,
      atx.super_agent_id,
      COALESCE(agent_profile.business_name, ''),
      COALESCE(agent_profile.full_name, ''),
      COALESCE(agent.email, '')
  ),
  super_agent_totals AS (
    SELECT
      atx.super_agent_id,
      COALESCE(sa_profile.business_name, '') AS business_name,
      COALESCE(sa_profile.full_name, '') AS full_name,
      COALESCE(sa.email, '') AS email,
      COUNT(*) FILTER (WHERE atx.is_active = 1) AS transaction_count,
      COALESCE(SUM(atx.gross_amount) FILTER (WHERE atx.is_active = 1), 0) AS gross_sales,
      COALESCE(SUM(atx.agent_markup) FILTER (WHERE atx.is_active = 1), 0) AS markup_earnings,
      COALESCE(SUM(atx.super_agent_amount) FILTER (WHERE atx.is_active = 1), 0) AS super_agent_revenue
    FROM agent_transactions AS atx
    LEFT JOIN public.user_profiles AS sa_profile
      ON sa_profile.id = atx.super_agent_id
    LEFT JOIN auth.users AS sa
      ON sa.id = atx.super_agent_id
    WHERE atx.super_agent_id IS NOT NULL
    GROUP BY
      atx.super_agent_id,
      COALESCE(sa_profile.business_name, ''),
      COALESCE(sa_profile.full_name, ''),
      COALESCE(sa.email, '')
  ),
  daily_trend AS (
    SELECT
      date_trunc('day', created_at)::date AS day,
      COUNT(*) FILTER (WHERE is_active = 1) AS transaction_count,
      COALESCE(SUM(super_agent_amount) FILTER (WHERE is_active = 1), 0) AS earnings,
      COALESCE(SUM(agent_markup) FILTER (WHERE is_active = 1), 0) AS markup_earnings,
      COALESCE(SUM(gross_amount) FILTER (WHERE is_active = 1), 0) AS gross_sales
    FROM agent_transactions
    WHERE created_at >= current_date - interval '13 days'
    GROUP BY date_trunc('day', created_at)::date
  )
  SELECT jsonb_build_object(
    'scope', jsonb_build_object(
      'role', CASE
        WHEN effective_super_agent_id IS NULL THEN 'admin'
        ELSE 'super_agent'
      END,
      'super_agent_id', effective_super_agent_id
    ),
    'earnings', jsonb_build_object(
      'today', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= current_date),
      'week', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('week', now())),
      'month', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('month', now())),
      'year', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('year', now())),
      'all_time', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1)
    ),
    'sub_agent_sales', jsonb_build_object(
      'transaction_count', (SELECT COUNT(*) FROM agent_transactions WHERE is_active = 1),
      'gross_sales', (SELECT COALESCE(SUM(gross_amount), 0) FROM agent_transactions WHERE is_active = 1),
      'base_cost', (SELECT COALESCE(SUM(base_amount), 0) FROM agent_transactions WHERE is_active = 1),
      'markup_earnings', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1),
      'platform_fees', (SELECT COALESCE(SUM(transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
      'super_agent_revenue', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1),
      'active_sub_agents', (SELECT COUNT(DISTINCT agent_id) FROM agent_transactions WHERE is_active = 1),
      'held_count', (SELECT COUNT(*) FROM agent_transactions WHERE order_status = 'held'),
      'cancelled_count', (SELECT COUNT(*) FROM agent_transactions WHERE order_status IN ('cancelled', 'failed'))
    ),
    'super_agent_purchases', jsonb_build_object(
      'transaction_count', (SELECT COUNT(*) FROM super_agent_purchases WHERE is_active = 1),
      'wallet_spend', (SELECT COALESCE(SUM(gross_amount), 0) FROM super_agent_purchases WHERE is_active = 1),
      'base_cost', (SELECT COALESCE(SUM(base_amount), 0) FROM super_agent_purchases WHERE is_active = 1),
      'cancelled_count', (SELECT COUNT(*) FROM super_agent_purchases WHERE order_status IN ('cancelled', 'failed'))
    ),
    'wallets', jsonb_build_object(
      'current_balance', (SELECT total_balance FROM wallet_balances),
      'funded_wallet_count', (SELECT funded_wallet_count FROM wallet_balances),
      'current_month_credits', (SELECT COALESCE(SUM(amount), 0) FROM wallet_movements WHERE entry_type = 'credit' AND amount > 0 AND created_at >= date_trunc('month', now())),
      'current_month_debits', (SELECT COALESCE(ABS(SUM(amount)), 0) FROM wallet_movements WHERE entry_type = 'debit' AND amount < 0 AND created_at >= date_trunc('month', now())),
      'net_wallet_funding', (SELECT COALESCE(SUM(amount), 0) FROM wallet_funding)
    ),
    'afa', jsonb_build_object(
      'transaction_count', (SELECT COUNT(*) FROM afa_entries),
      'net_collected', (SELECT COALESCE(SUM(signed_amount), 0) FROM afa_entries),
      'paystack_collected', (SELECT COALESCE(SUM(signed_amount), 0) FROM afa_entries WHERE payment_method = 'paystack'),
      'wallet_spend', (SELECT COALESCE(ABS(SUM(signed_amount)), 0) FROM afa_entries WHERE payment_method = 'wallet' AND entry_type <> 'refund')
    ),
    'sub_agents', COALESCE((
      SELECT jsonb_agg(to_jsonb(agent_row) ORDER BY agent_row.markup_earnings DESC)
      FROM (
        SELECT
          agent_id,
          super_agent_id,
          COALESCE(NULLIF(business_name, ''), NULLIF(full_name, ''), split_part(COALESCE(email, ''), '@', 1), 'Sub-agent') AS name,
          transaction_count,
          gross_sales,
          base_cost,
          markup_earnings,
          platform_fees,
          super_agent_revenue
        FROM sub_agent_totals
      ) AS agent_row
    ), '[]'::jsonb),
    'super_agents', COALESCE((
      SELECT jsonb_agg(to_jsonb(super_agent_row) ORDER BY super_agent_row.markup_earnings DESC)
      FROM (
        SELECT
          super_agent_id,
          COALESCE(NULLIF(business_name, ''), NULLIF(full_name, ''), split_part(COALESCE(email, ''), '@', 1), 'Super Agent') AS name,
          transaction_count,
          gross_sales,
          markup_earnings,
          super_agent_revenue
        FROM super_agent_totals
      ) AS super_agent_row
    ), '[]'::jsonb),
    'daily_trend', COALESCE((
      SELECT jsonb_agg(to_jsonb(trend_row) ORDER BY trend_row.day)
      FROM (
        SELECT
          day,
          transaction_count,
          earnings,
          markup_earnings,
          gross_sales
        FROM daily_trend
      ) AS trend_row
    ), '[]'::jsonb)
  )
  INTO result;

  RETURN result;
END;
$$;

-- User-app entry point. A Super Agent can only ever request their own scope.
CREATE OR REPLACE FUNCTION public.get_business_analytics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_id uuid := auth.uid();
  caller_role text;
  scope_id uuid;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  caller_role := lower(coalesce(
    auth.jwt() -> 'user_metadata' ->> 'role',
    auth.jwt() -> 'app_metadata' ->> 'role',
    ''
  ));

  IF caller_role NOT IN ('admin', 'superagent', 'super_agent') THEN
    caller_role := lower(coalesce((
      SELECT role
      FROM public.user_profiles
      WHERE id = caller_id
    ), ''));
  END IF;

  IF caller_role = 'admin' THEN
    scope_id := NULL;
  ELSIF caller_role IN ('superagent', 'super_agent') THEN
    scope_id := caller_id;
  ELSE
    RAISE EXCEPTION 'Admin or Super Agent role required';
  END IF;

  RETURN public.calculate_business_analytics(scope_id);
END;
$$;

-- Admin-app entry point for the existing service-role client. The browser
-- client should be migrated to the anon key later, after all admin writes
-- have been moved behind role-checked Edge Functions or RPCs.
CREATE OR REPLACE FUNCTION public.get_admin_business_analytics()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.calculate_business_analytics(NULL);
$$;

REVOKE ALL ON FUNCTION public.calculate_business_analytics(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calculate_business_analytics(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_business_analytics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_business_analytics() TO authenticated;
REVOKE ALL ON FUNCTION public.get_admin_business_analytics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_business_analytics() TO service_role;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_super_agent_created
  ON public.payment_transactions (super_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_orders_super_agent_created
  ON public.agent_orders (super_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_afa_ledger_registration_created
  ON public.afa_payment_ledger (registration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_agent_created
  ON public.wallet_topups (agent_id, created_at DESC);

-- Snapshot the buyer channel on both the order and payment ledger. Existing
-- rows remain NULL and the admin app safely derives their origin.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS buyer_type text
  CHECK (buyer_type IS NULL OR buyer_type IN ('normal_user', 'sub_agent', 'super_agent'));

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS buyer_type text
  CHECK (buyer_type IS NULL OR buyer_type IN ('normal_user', 'sub_agent', 'super_agent'));

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS buyer_type text
  CHECK (buyer_type IS NULL OR buyer_type IN ('normal_user', 'sub_agent', 'super_agent'));

CREATE INDEX IF NOT EXISTS idx_orders_buyer_type_created
  ON public.orders (buyer_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_orders_buyer_type_created
  ON public.agent_orders (buyer_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_buyer_type_created
  ON public.payment_transactions (buyer_type, created_at DESC);

COMMIT;
