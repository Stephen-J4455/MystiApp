BEGIN;

-- ===========================================================================
-- Super Agent analytics: derive profit from the ADMIN BASE PRICE
-- (their tier price), not from the client-supplied `agent_markup`
-- ===========================================================================
-- APPLY AFTER: 20261003_004 (analytics_money_split)
--
-- WHY
-- ---
-- `calculate_business_analytics` reported profit as SUM(agent_markup), and
-- `agent_markup` is a SNAPSHOT of what the CLIENT claimed at checkout. In
-- `verify-payment`, `hasPaymentSplit` gates it behind four-term arithmetic on
-- client-supplied numbers:
--
--     base + tier_extra + fee == gross       (within 0.01)
--     fee == base * superAgentChargePercent   (within 0.01)
--
-- If ANY term fails, the function falls through to a default branch that sets
-- `agent_markup = 0` and `base_amount = gross`. The order still succeeds, the
-- sub-agent is still charged, the wallet is still debited - and analytics
-- silently record the whole gross as the super agent's own profit.
--
-- So `agent_markup` cannot be trusted as the input to a profit figure. The
-- trustworthy number is already on the row:
--
--     payment_transactions.base_amount
--
-- which is the admin base price for the super agent's tier - the same figure
-- debited from their wallet (`p_amount: settlement.baseAmount`) and the same
-- figure the admin's pricing screen edits.
--
-- Profit is therefore DERIVED on the read path:
--
--     profit = gross_amount - base_amount - transaction_fee
--
-- For a sub-agent order gross = base + markup + fee, so this collapses to
-- exactly `markup`. Same figure on a validated order, but derived from the
-- price the admin set, so it is correct when the client sent nothing usable.
-- Where `base_amount` fell back to `gross` server-side it yields
-- `gross - gross - fee = -fee`: an honest zero-or-negative, never a
-- fabricated markup.
--
-- `transaction_fee` is the platform's charge, so subtracting it removes money
-- that passes through to nobody rather than to the super agent.
--
-- The old column is still reported as `markup_recorded` for audit: where it
-- agrees with the derived figure the split was validated, where it disagrees
-- the client sent something unverifiable.
--
-- api_cost IS NOT TOUCHED. It is the platform's real provider cost, and the
-- admin app's gain (gross - agent_markup - api_cost) is correct BECAUSE it uses
-- it. Overwriting base price into api_cost would destroy the platform's cost
-- data and corrupt every downstream margin report. This migration changes the
-- SUPER AGENT's P&L only; `get_admin_channel_revenue_analytics` is not
-- redefined.

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
      -- THE ADMIN BASE PRICE for this super agent's tier. Authoritative: it is
      -- what their wallet was debited and what the admin's pricing screen edits.
      -- Profit below is derived from this, never from `agent_markup`.
      COALESCE(pt.base_amount, 0) AS admin_base_price,
      -- What delivery cost the PLATFORM. Reported for the admin scope only and
      -- never used in the super agent's profit.
      COALESCE(ao.api_cost, pt.base_amount) AS provider_cost,
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
      COALESCE(SUM(atx.admin_base_price) FILTER (WHERE atx.is_active = 1), 0) AS base_cost,
      -- DERIVED from the admin base price: gross - base - fee == markup.
      COALESCE(SUM(atx.gross_amount - atx.admin_base_price - atx.transaction_fee)
               FILTER (WHERE atx.is_active = 1), 0) AS markup_earnings,
      COALESCE(SUM(atx.agent_markup) FILTER (WHERE atx.is_active = 1), 0) AS markup_recorded,
      COALESCE(SUM(atx.provider_cost) FILTER (WHERE atx.is_active = 1), 0) AS provider_cost,
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
      COALESCE(SUM(atx.admin_base_price) FILTER (WHERE atx.is_active = 1), 0) AS base_cost,
      COALESCE(SUM(atx.gross_amount - atx.admin_base_price - atx.transaction_fee)
               FILTER (WHERE atx.is_active = 1), 0) AS markup_earnings,
      COALESCE(SUM(atx.agent_markup) FILTER (WHERE atx.is_active = 1), 0) AS markup_recorded,
      COALESCE(SUM(atx.transaction_fee) FILTER (WHERE atx.is_active = 1), 0) AS platform_fees,
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
      -- Same derivation as `markup_earnings`, so the trend cannot disagree
      -- with the headline it sits under.
      COALESCE(SUM(gross_amount - admin_base_price - transaction_fee)
               FILTER (WHERE is_active = 1), 0) AS profit,
      COALESCE(SUM(gross_amount - admin_base_price - transaction_fee)
               FILTER (WHERE is_active = 1), 0) AS markup_earnings,
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
      'all_time', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1),
      -- PROFIT, DERIVED FROM THE ADMIN BASE PRICE. `earnings.*` above is
      -- base + markup, so it overstates profit by the whole pass-through cost.
      'profit_today', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= current_date),
      'profit_week', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('week', now())),
      'profit_month', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('month', now())),
      'profit_year', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('year', now())),
      'profit_all_time', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1)
    ),
    'sub_agent_sales', jsonb_build_object(
      'transaction_count', (SELECT COUNT(*) FROM agent_transactions WHERE is_active = 1),
      'gross_sales', (SELECT COALESCE(SUM(gross_amount), 0) FROM agent_transactions WHERE is_active = 1),
      -- The admin base price: what the super agent paid the platform for the
      -- data they resold. Revenue for the platform, a cost to them.
      'base_cost', (SELECT COALESCE(SUM(admin_base_price), 0) FROM agent_transactions WHERE is_active = 1),
      'markup_profit', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
      'markup_earnings', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
      -- What the client claimed, kept for audit only.
      'markup_recorded', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1),
      'provider_cost', (SELECT COALESCE(SUM(provider_cost), 0) FROM agent_transactions WHERE is_active = 1),
      'platform_fees', (SELECT COALESCE(SUM(transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
      'super_agent_revenue', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1),
      'active_sub_agents', (SELECT COUNT(DISTINCT agent_id) FROM agent_transactions WHERE is_active = 1),
      'held_count', (SELECT COUNT(*) FROM agent_transactions WHERE order_status = 'held'),
      'cancelled_count', (SELECT COUNT(*) FROM agent_transactions WHERE order_status IN ('cancelled', 'failed'))
    ),
    -- The platform's own money, admin scope only. Still measured against the
    -- REAL provider cost - the base price is the super agent's cost, not the
    -- platform's, so using it here would overstate platform profit by the
    -- entire provider margin.
    'platform', CASE
      WHEN effective_super_agent_id IS NULL THEN jsonb_build_object(
        'gross_collected', (SELECT COALESCE(SUM(gross_amount), 0) FROM agent_transactions WHERE is_active = 1),
        'provider_cost', (SELECT COALESCE(SUM(provider_cost), 0) FROM agent_transactions WHERE is_active = 1),
        'tier_revenue', (SELECT COALESCE(SUM(admin_base_price), 0) FROM agent_transactions WHERE is_active = 1),
        'fees_collected', (SELECT COALESCE(SUM(transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
        'markup_paid_to_super_agents', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
        -- base + fee - provider_cost. The markup is excluded on purpose: it is
        -- money the platform collected and immediately passed on.
        'gain', (SELECT COALESCE(SUM(admin_base_price + transaction_fee - provider_cost), 0) FROM agent_transactions WHERE is_active = 1)
      )
      ELSE NULL
    END,
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
          markup_recorded,
          provider_cost,
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
          base_cost,
          markup_earnings,
          markup_recorded,
          platform_fees,
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
          profit,
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

REVOKE ALL ON FUNCTION public.calculate_business_analytics(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calculate_business_analytics(uuid) TO service_role;

COMMIT;
