BEGIN;

-- Analytics money split.
--
-- WHAT WAS WRONG
-- --------------
-- A sub-agent order is paid as:
--
--     gross = base + markup + fee
--             |      |       |
--             |      |       +-- platform transaction charge -> ADMIN
--             |      +---------- super agent's own markup   -> SUPER AGENT
--             +----------------- price admin set for the
--                              super agent tier            -> passes through
--
-- `get_admin_channel_revenue_analytics` computed gain as
--
--     gain = gross_amount - api_cost
--
-- `markup` is inside `gross_amount`, so that formula counted the SUPER AGENT's
-- own margin as PLATFORM gain. On any order where the super agent charges a
-- markup, admin "gain" was inflated by exactly that markup - the platform
-- reported profit it never earned.
--
-- The corrected formula excludes the markup, because it belongs to somebody
-- else:
--
--     gain = gross_amount - agent_markup - api_cost
--            = base + fee - api_cost
--
-- Applied uniformly across every channel, which is safe because `agent_markup`
-- is 0 for normal-user orders and for a super agent's own purchases, so the
-- formula is unchanged wherever there is no markup to remove.
--
-- `calculate_business_analytics` had the mirror problem: it reported
-- `super_agent_amount` (= base + markup) as the headline "earnings", so the
-- super agent's own screen presented the pass-through cost as profit. It now
-- also reports the markup on its own, and the platform's share separately, so
-- neither side has to subtract a guessed number.

-- ---------------------------------------------------------------------------
-- 1. Platform gain by channel, with the super agent's markup removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_channel_revenue_analytics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  WITH
  -- One row per settled payment, tagged with its buyer channel and the cost
  -- that sale actually carried. Cancelled/failed orders are excluded so they
  -- never inflate a period.
  channel_tx AS (
    SELECT
      pt.created_at,
      COALESCE(
        NULLIF(pt.buyer_type, ''),
        CASE
          WHEN pt.order_type = 'agent' THEN 'sub_agent'
          WHEN pt.order_type = 'regular'
               AND pt.payment_reference LIKE 'wallet_%'
            THEN 'super_agent'
          ELSE 'normal_user'
        END
      ) AS channel,
      pt.gross_amount,
      -- The super agent's margin. Not part of the platform's revenue, so it is
      -- carried through the CTE purely to be subtracted back out below.
      -- 0 on every normal-user and self-purchase row.
      pt.agent_markup,
      COALESCE(
        CASE
          WHEN pt.order_type = 'agent' THEN agent_order.api_cost
          ELSE normal_order.api_cost
        END,
        pt.base_amount
      ) AS effective_cost,
      pt.transaction_fee
    FROM public.payment_transactions AS pt
    -- Both joins are LEFT: a payment row belongs to exactly ONE of the two
    -- order tables, so an INNER JOIN on either would drop the other's rows.
    LEFT JOIN public.orders AS normal_order
      ON pt.order_type = 'regular'
     AND normal_order.id = pt.order_id
    LEFT JOIN public.agent_orders AS agent_order
      ON pt.order_type = 'agent'
     AND agent_order.id = pt.order_id
    -- The payment must have found its order table, and that order must not be
    -- cancelled or failed. An orphaned payment row (missing order) is dropped
    -- rather than counted with unknown cost.
    -- coalesce(status, '') guards the NULL case: `NULL NOT IN (...)` evaluates
    -- to NULL, not TRUE, which would silently drop a real order.
    WHERE CASE
            WHEN pt.order_type = 'regular' THEN normal_order.id IS NOT NULL
              AND coalesce(normal_order.status, '')
                NOT IN ('cancelled', 'failed')
            WHEN pt.order_type = 'agent' THEN agent_order.id IS NOT NULL
              AND coalesce(agent_order.status, '')
                NOT IN ('cancelled', 'failed')
            ELSE false
          END
  ),
  -- Window starts for each reporting period. 'all_time' uses -infinity so the
  -- same LEFT JOIN + FILTER pattern works for it as for the bounded windows.
  periods AS (
    SELECT *
    FROM (
      VALUES
        ('today', current_date::timestamptz),
        ('week', date_trunc('week', now())),
        ('month', date_trunc('month', now())),
        ('year', date_trunc('year', now())),
        ('all_time', '-infinity'::timestamptz)
    ) AS period(period, since)
  ),
  -- The synthetic 'all' channel rolls the three buyer channels into the
  -- platform total. It is filtered back out of the per-channel array.
  channels AS (
    SELECT *
    FROM (
      VALUES
        ('normal_user'::text, 'Normal Users'::text, 1),
        ('sub_agent', 'Agents', 2),
        ('super_agent', 'Super Agents', 3),
        ('all', 'All channels', 0)
    ) AS channel(channel, label, sort)
  ),
  per_channel AS (
    SELECT
      c.channel,
      c.label,
      c.sort,
      p.period,
      COUNT(tx.created_at)::int AS transactions,
      COALESCE(SUM(tx.gross_amount), 0) AS gross_sales,
      COALESCE(SUM(tx.effective_cost), 0) AS api_cost,
      -- THE FIX. `agent_markup` is the super agent's own margin on a sub-agent
      -- order (and on a sub-agent's wallet purchase). It is collected by the
      -- super agent, so counting it as platform gain double-attributes it:
      -- once as super agent profit and again as admin profit. Subtracting it
      -- leaves `base + fee - api_cost`, which is money the platform actually
      -- keeps. It is 0 on normal-user rows, so that channel is unchanged.
      COALESCE(
        SUM(tx.gross_amount - tx.agent_markup - tx.effective_cost), 0
      ) AS gain,
      -- Reported so the admin can reconcile: this markup is PAID OUT of
      -- platform revenue to the super agents, not kept by the platform.
      COALESCE(SUM(tx.agent_markup), 0) AS agent_markup_paid,
      COALESCE(SUM(tx.transaction_fee), 0) AS platform_fees
    FROM channels AS c
    CROSS JOIN periods AS p
    LEFT JOIN channel_tx AS tx
      ON tx.created_at >= p.since
     -- The 'all' row must match EVERY real channel, not just one. A plain
     -- equality on 'all' would match no rows and report a total of 0.
     AND (c.channel = 'all' OR tx.channel = c.channel)
    GROUP BY c.channel, c.label, c.sort, p.period
  ),
  channel_scope AS (
    SELECT DISTINCT channel, label, sort
    FROM per_channel
  ),
  daily_trend AS (
    SELECT
      date_trunc('day', tx.created_at)::date AS day,
      COALESCE(SUM(tx.gross_amount - tx.agent_markup - tx.effective_cost)
        FILTER (WHERE tx.channel = 'normal_user'), 0) AS normal_user,
      COALESCE(SUM(tx.gross_amount - tx.agent_markup - tx.effective_cost)
        FILTER (WHERE tx.channel = 'sub_agent'), 0) AS sub_agent,
      COALESCE(SUM(tx.gross_amount - tx.agent_markup - tx.effective_cost)
        FILTER (WHERE tx.channel = 'super_agent'), 0) AS super_agent,
      COALESCE(SUM(tx.gross_amount - tx.agent_markup - tx.effective_cost), 0)
        AS total,
      COUNT(*)::int AS transactions
    FROM channel_tx AS tx
    WHERE tx.created_at >= current_date - interval '13 days'
    GROUP BY date_trunc('day', tx.created_at)::date
  )
  SELECT jsonb_build_object(
    'channels', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'channel', scope.channel,
          'label', scope.label,
          'periods', (
            SELECT COALESCE(
              jsonb_object_agg(
                row.period,
                jsonb_build_object(
                  'transactions', row.transactions,
                  'gross_sales', row.gross_sales,
                  'api_cost', row.api_cost,
                  'gain', row.gain,
                  'agent_markup_paid', row.agent_markup_paid,
                  'platform_fees', row.platform_fees
                )
              ),
              '{}'::jsonb
            )
            FROM per_channel AS row
            WHERE row.channel = scope.channel
          )
        )
        ORDER BY scope.sort
      )
      FROM channel_scope AS scope
      WHERE scope.channel <> 'all'
    ), '[]'::jsonb),
    'totals', COALESCE((
      SELECT jsonb_object_agg(
        row.period,
        jsonb_build_object(
          'transactions', row.transactions,
          'gross_sales', row.gross_sales,
          'api_cost', row.api_cost,
          'gain', row.gain,
          'agent_markup_paid', row.agent_markup_paid,
          'platform_fees', row.platform_fees
        )
      )
      FROM per_channel AS row
      WHERE row.channel = 'all'
    ), '{}'::jsonb),
    'daily_trend', COALESCE((
      SELECT jsonb_agg(to_jsonb(trend_row) ORDER BY trend_row.day)
      FROM (
        SELECT
          day,
          transactions,
          normal_user,
          sub_agent,
          super_agent,
          total
        FROM daily_trend
      ) AS trend_row
    ), '[]'::jsonb)
  )
  INTO result;

  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Super Agent facing analytics: separate profit from pass-through cost.
-- ---------------------------------------------------------------------------
--
-- `earnings` is LEFT EXACTLY AS IT WAS (`SUM(super_agent_amount)` =
-- base + markup) so the admin app's existing renders keep their meaning.
--
-- Added alongside it, because neither side had to guess:
--
--   profit_*            the super agent's markup, i.e. what they actually earn
--   sub_agent_sales.markup_profit    same figure, all time
--   sub_agent_sales.provider_cost    what delivering the data really cost
--   platform.*          the platform's own share, admin scope only

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
      -- What the delivery actually cost the platform. Falls back to
      -- `base_amount` for historical rows written before the api_cost
      -- snapshot existed - the same fallback `dispatch-order` uses.
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
      COALESCE(SUM(atx.base_amount) FILTER (WHERE atx.is_active = 1), 0) AS base_cost,
      COALESCE(SUM(atx.agent_markup) FILTER (WHERE atx.is_active = 1), 0) AS markup_earnings,
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
      -- The super agent's actual profit, as opposed to the pass-through cost
      -- bundled into `earnings`.
      COALESCE(SUM(agent_markup) FILTER (WHERE is_active = 1), 0) AS profit,
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
      'all_time', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1),
      -- Markup only. `earnings.*` above is base + markup, so it overstates
      -- profit by the whole pass-through cost.
      'profit_today', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= current_date),
      'profit_week', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('week', now())),
      'profit_month', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('month', now())),
      'profit_year', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('year', now())),
      'profit_all_time', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1)
    ),
    'sub_agent_sales', jsonb_build_object(
      'transaction_count', (SELECT COUNT(*) FROM agent_transactions WHERE is_active = 1),
      'gross_sales', (SELECT COALESCE(SUM(gross_amount), 0) FROM agent_transactions WHERE is_active = 1),
      -- The pass-through: what the platform charged the super agent for the
      -- data. It is revenue for the platform and a COST for the super agent,
      -- which is why the two screens label it differently.
      'base_cost', (SELECT COALESCE(SUM(base_amount), 0) FROM agent_transactions WHERE is_active = 1),
      -- What the super agents earned on top of that pass-through.
      'markup_profit', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1),
      'markup_earnings', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1),
      'provider_cost', (SELECT COALESCE(SUM(provider_cost), 0) FROM agent_transactions WHERE is_active = 1),
      'platform_fees', (SELECT COALESCE(SUM(transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
      'super_agent_revenue', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1),
      'active_sub_agents', (SELECT COUNT(DISTINCT agent_id) FROM agent_transactions WHERE is_active = 1),
      'held_count', (SELECT COUNT(*) FROM agent_transactions WHERE order_status = 'held'),
      'cancelled_count', (SELECT COUNT(*) FROM agent_transactions WHERE order_status IN ('cancelled', 'failed'))
    ),
    -- The platform's own money on those same orders. Null in a super agent
    -- scope, where the platform is simply not this caller's business.
    'platform', CASE
      WHEN effective_super_agent_id IS NULL THEN jsonb_build_object(
        'gross_collected', (SELECT COALESCE(SUM(gross_amount), 0) FROM agent_transactions WHERE is_active = 1),
        'provider_cost', (SELECT COALESCE(SUM(provider_cost), 0) FROM agent_transactions WHERE is_active = 1),
        'tier_revenue', (SELECT COALESCE(SUM(base_amount), 0) FROM agent_transactions WHERE is_active = 1),
        'fees_collected', (SELECT COALESCE(SUM(transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
        'markup_paid_to_super_agents', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1),
        -- tier_revenue + fees - provider_cost. The markup is excluded on
        -- purpose: it is money the platform collected and immediately passed
        -- on, and counting it would overstate profit by exactly that amount.
        'gain', (SELECT COALESCE(SUM(base_amount + transaction_fee - provider_cost), 0) FROM agent_transactions WHERE is_active = 1)
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

CREATE INDEX IF NOT EXISTS idx_agent_orders_super_agent_created
  ON public.agent_orders (super_agent_id, created_at DESC);

-- Grants are re-asserted rather than assumed. `CREATE OR REPLACE` preserves an
-- existing ACL, so these are normally no-ops - but both bodies were rewritten
-- here to return a corrected revenue split, and re-stating the grants means this
-- migration leaves the function exactly as locked down as 20260924_004 and
-- 20260926_004 left it, instead of depending on those having been applied.
--
-- `get_business_analytics()` is deliberately NOT redefined: it already delegates
-- to `calculate_business_analytics(scope_id)`, so the Super Agent app picks up
-- the new fields through the replace above.
REVOKE ALL ON FUNCTION public.calculate_business_analytics(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calculate_business_analytics(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_admin_channel_revenue_analytics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_channel_revenue_analytics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_channel_revenue_analytics() TO service_role;

COMMIT;