BEGIN;

-- Channel revenue analytics for the admin app.
--
-- The existing `get_admin_business_analytics` only reads AGENT transactions
-- (payment_transactions.order_type = 'agent'), so its "earnings" headline is
-- the Super Agent's own income and normal-user sales are absent entirely.
-- This function adds a gain breakdown per buyer channel - normal users plus
-- every agent type - across today / this week / this month / this year.
--
-- GAIN DEFINITION (deliberately uniform across channels):
--   gain = gross_amount - effective_api_cost
-- This is the true economic margin of a sale and is directly comparable
-- between channels. Two rules from the existing ledger make it safe to apply
-- the same formula everywhere:
--
--   1. NEVER subtract `base_amount` on a normal-user order. For those rows
--      `base_amount` was set to the customer price, so gross - base_amount is
--      always 0. The real cost is the snapshotted `api_cost`.
--   2. NEVER add `transaction_fee` on top of the gain. On a split sub-agent
--      order the fee is a COMPONENT of gross_amount (it is carved out of the
--      base and paid to the platform), so adding it would double count. It is
--      reported separately as context only.
--
-- COST FALLBACK CHAIN: api_cost -> base_amount. Historical orders predate the
-- snapshot and have api_cost = NULL; for those base_amount was the recorded
-- cost, which is the same fallback `dispatch-order` already uses. For a
-- legacy normal-user order that fallback yields base_amount = sale price and
-- therefore a gain of 0 - the honest reading of a row that never recorded a
-- cost.
--
-- AFA IS EXCLUDED. AFA registration money is a pass-through with its own
-- downstream payout; counting it as platform gain would overstate profit.
--
-- BUYER CHANNEL DERIVATION: `buyer_type` is snapshotted on every payment by
-- verify-payment, but rows written before that column existed are NULL. Those
-- fall back to the order table the payment points at, which is unambiguous:
-- agent_orders => sub_agent, wallet-funded orders => super_agent, everything
-- else => normal_user.

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
      COALESCE(SUM(tx.gross_amount - tx.effective_cost), 0) AS gain,
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
      COALESCE(SUM(tx.gross_amount - tx.effective_cost)
        FILTER (WHERE tx.channel = 'normal_user'), 0) AS normal_user,
      COALESCE(SUM(tx.gross_amount - tx.effective_cost)
        FILTER (WHERE tx.channel = 'sub_agent'), 0) AS sub_agent,
      COALESCE(SUM(tx.gross_amount - tx.effective_cost)
        FILTER (WHERE tx.channel = 'super_agent'), 0) AS super_agent,
      COALESCE(SUM(tx.gross_amount - tx.effective_cost), 0) AS total,
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

-- Grants.
--
-- The admin app (MystiAdminApp/src/lib/supabase.js) uses the ANON key and
-- signs in with `signInWithPassword`, so its RPC calls execute as the
-- `authenticated` role - NOT service_role. Granting only to service_role
-- (as 20260924_004 does) leaves this function unreachable for the very client
-- that needs it, which fails at runtime with PGRST202.
--
-- Execute is revoked from PUBLIC first because a function is executable by
-- PUBLIC by default, and this returns platform revenue figures.
REVOKE ALL ON FUNCTION public.get_admin_channel_revenue_analytics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_channel_revenue_analytics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_channel_revenue_analytics() TO service_role;

-- Supporting index: the analytics scan filters on order_type and orders are
-- already indexed by (buyer_type, created_at DESC) from 20260924_004.
CREATE INDEX IF NOT EXISTS idx_payment_transactions_type_created
  ON public.payment_transactions (order_type, created_at DESC);

COMMIT;
