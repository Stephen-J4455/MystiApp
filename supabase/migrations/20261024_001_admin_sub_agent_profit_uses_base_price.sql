BEGIN;

-- The platform's profit on a sub-agent sale is the admin-set price charged to
-- the super agent minus the provider cost. The sub-agent's markup belongs to
-- the super agent and must not be counted as platform profit.
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
  payment_rows AS (
    SELECT
      pt.created_at,
      CASE
        -- Wallet-funded sub-agent orders are stored as regular orders. The
        -- mirrored debit is the reliable discriminator for historic rows
        -- whose buyer_type was recorded as super_agent.
        WHEN pt.order_type = 'regular'
          AND EXISTS (
            SELECT 1
            FROM public.super_agent_wallet_ledger AS mirror
            WHERE mirror.order_id = pt.order_id
              AND mirror.entry_type = 'debit'
              AND mirror.reason = 'sub_agent_package_purchase'
          )
          THEN 'sub_agent'
        WHEN pt.order_type = 'agent' THEN 'sub_agent'
        ELSE COALESCE(
          NULLIF(pt.buyer_type, ''),
          CASE
            WHEN pt.order_type = 'regular'
                 AND pt.payment_reference LIKE 'wallet_%'
              THEN 'super_agent'
            WHEN pt.order_type = 'regular' THEN 'normal_user'
            ELSE ''
          END
        )
      END AS channel,
      pt.gross_amount,
      pt.base_amount,
      CASE
        WHEN pt.order_type = 'agent' THEN
          CASE
            WHEN agent_order.cost_source = 'fallback' THEN NULL
            ELSE agent_order.api_cost
          END
        WHEN EXISTS (
          SELECT 1
          FROM public.super_agent_wallet_ledger AS mirror
          WHERE mirror.order_id = pt.order_id
            AND mirror.entry_type = 'debit'
            AND mirror.reason = 'sub_agent_package_purchase'
        ) THEN
          CASE
            WHEN normal_order.cost_source = 'fallback' THEN NULL
            ELSE normal_order.api_cost
          END
        ELSE COALESCE(normal_order.api_cost, pt.base_amount)
      END AS effective_cost,
      pt.transaction_fee
    FROM public.payment_transactions AS pt
    LEFT JOIN public.orders AS normal_order
      ON pt.order_type = 'regular'
     AND normal_order.id = pt.order_id
    LEFT JOIN public.agent_orders AS agent_order
      ON pt.order_type = 'agent'
     AND agent_order.id = pt.order_id
    WHERE CASE
      WHEN pt.order_type = 'regular' THEN normal_order.id IS NOT NULL
        AND COALESCE(normal_order.status, '') NOT IN ('cancelled', 'failed')
      WHEN pt.order_type = 'agent' THEN agent_order.id IS NOT NULL
        AND COALESCE(agent_order.status, '') NOT IN ('cancelled', 'failed')
      ELSE false
    END
  ),
  channel_tx AS (
    SELECT
      created_at,
      channel,
      gross_amount,
      CASE
        WHEN channel = 'sub_agent' THEN COALESCE(base_amount, 0)
        WHEN channel = 'normal_user' THEN gross_amount - COALESCE(transaction_fee, 0)
        ELSE gross_amount
      END AS platform_revenue,
      effective_cost,
      transaction_fee
    FROM payment_rows
  ),
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
  channels AS (
    SELECT *
    FROM (
      VALUES
        ('normal_user'::text, 'Normal Users'::text, 1),
        ('sub_agent', 'Sub-agents', 2),
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
      COALESCE(SUM(tx.platform_revenue), 0) AS platform_revenue,
      COALESCE(
        SUM(tx.platform_revenue) FILTER (WHERE tx.effective_cost IS NOT NULL),
        0
      ) AS profit_revenue,
      COALESCE(
        SUM(tx.effective_cost) FILTER (WHERE tx.effective_cost IS NOT NULL),
        0
      ) AS api_cost,
      COALESCE(
        SUM(tx.platform_revenue - tx.effective_cost)
          FILTER (WHERE tx.effective_cost IS NOT NULL),
        0
      ) AS gain,
      COUNT(tx.created_at) FILTER (WHERE tx.effective_cost IS NULL)::int
        AS missing_api_cost_orders,
      COALESCE(SUM(tx.transaction_fee), 0) AS platform_fees,
      COALESCE(
        SUM(tx.transaction_fee) FILTER (WHERE tx.channel = 'normal_user'),
        0
      ) AS paystack_charge
    FROM channels AS c
    CROSS JOIN periods AS p
    LEFT JOIN channel_tx AS tx
      ON tx.created_at >= p.since
     AND (c.channel = 'all' OR tx.channel = c.channel)
    GROUP BY c.channel, c.label, c.sort, p.period
  ),
  daily_trend AS (
    SELECT
      date_trunc('day', tx.created_at)::date AS day,
      COALESCE(SUM(tx.platform_revenue - tx.effective_cost)
        FILTER (WHERE tx.channel = 'normal_user'), 0) AS normal_user,
      COALESCE(SUM(tx.platform_revenue - tx.effective_cost)
        FILTER (WHERE tx.channel = 'sub_agent'), 0) AS sub_agent,
      COALESCE(SUM(tx.platform_revenue - tx.effective_cost)
        FILTER (WHERE tx.channel = 'super_agent'), 0) AS super_agent,
      COALESCE(SUM(tx.platform_revenue - tx.effective_cost), 0) AS total,
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
                  'platform_revenue', row.platform_revenue,
                  'profit_revenue', row.profit_revenue,
                  'api_cost', row.api_cost,
                  'gain', row.gain,
                  'missing_api_cost_orders', row.missing_api_cost_orders,
                  'platform_fees', row.platform_fees,
                  'paystack_charge', row.paystack_charge
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
      FROM (SELECT DISTINCT channel, label, sort FROM per_channel) AS scope
      WHERE scope.channel <> 'all'
    ), '[]'::jsonb),
    'totals', COALESCE((
      SELECT jsonb_object_agg(
        row.period,
        jsonb_build_object(
          'transactions', row.transactions,
          'gross_sales', row.gross_sales,
          'platform_revenue', row.platform_revenue,
          'profit_revenue', row.profit_revenue,
          'api_cost', row.api_cost,
          'gain', row.gain,
          'missing_api_cost_orders', row.missing_api_cost_orders,
          'platform_fees', row.platform_fees,
          'paystack_charge', row.paystack_charge
        )
      )
      FROM per_channel AS row
      WHERE row.channel = 'all'
    ), '{}'::jsonb),
    'daily_trend', COALESCE((
      SELECT jsonb_agg(to_jsonb(trend_row) ORDER BY trend_row.day)
      FROM daily_trend AS trend_row
    ), '[]'::jsonb)
  )
  INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_channel_revenue_analytics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_channel_revenue_analytics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_channel_revenue_analytics() TO service_role;

COMMIT;
