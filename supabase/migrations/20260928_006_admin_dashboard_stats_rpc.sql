BEGIN;

-- ===========================================================================
-- One aggregate query for the admin dashboard
-- ===========================================================================
-- WHY
-- ---
-- `DashboardScreen.fetchStats` asked for the last 7 days of order volume with
-- a SEQUENTIAL loop:
--
--     for (let i = 6; i >= 0; i--) {
--       await supabase.from("orders")      .select("*", {count:"exact", head:true})...
--       await supabase.from("agent_orders").select("*", {count:"exact", head:true})...
--     }
--
-- That is 14 round trips, issued one after another, on top of the 5 other
-- counts fetchStats already makes. The whole screen sits behind
-- `if (loading) return <ActivityIndicator/>`, and `setLoading(false)` is in
-- fetchStats' `finally` - so the 7-day chart, drawn LAST, was blocking the
-- entire dashboard from rendering. The dashboard was slow because the least
-- important query on it was the one that finished last.
--
-- This function returns every one of those numbers in a single round trip.
--
-- WHY A FUNCTION AND NOT JUST PARALLEL `await`s
-- ----------------------------------------------
-- `Promise.all` over 14 count queries would cut wall clock to roughly one round
-- trip, which is the real user-visible fix, but it would still be 14 separate
-- PostgREST requests and 14 separate `count: exact` scans. One aggregate counts
-- in a single pass and returns one row, so it stays fast as the orders table
-- grows. Both changes ship together: the RPC is the win, and `Promise.all` is
-- what lets the other fetches overlap it instead of queueing behind it.
--
-- TIMEZONE
-- --------
-- The original client loop compared `dateStr + " 00:00:00"` against
-- `created_at`, and `dateStr` came from `toISOString()`, which is UTC. So the
-- buckets were already UTC. UTC bucketing is preserved here rather than
-- switching to server-local time, which would silently move every bar.
--
-- READ-ONLY AND SAFE
-- ------------------
-- Returns a single row of counts. No writes. `SECURITY INVOKER`, so the RLS on
-- `orders` / `agent_orders` / `notifications` still applies to the underlying
-- scans and this cannot become a way to read rows the caller could not already
-- read with the anon key.
--
-- `authenticated` rather than admin-only, deliberately: this exposes counts
-- only, and the caller was already permitted to count these same tables
-- directly. An admin gate here would break the screen for a Super Agent
-- without adding a real boundary.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.admin_dashboard_stats()
RETURNS TABLE (
  total_orders bigint,
  total_agent_orders bigint,
  total_offers bigint,
  total_agent_offers bigint,
  pending_orders bigint,
  pending_agent_orders bigint,
  total_notifications bigint,
  notifications_today bigint,
  daily_counts bigint[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH
  -- The 7 day buckets are a generated series so a day with zero orders still
  -- produces a slot. Aggregating over existing rows only would return 1-7 rows
  -- and the chart would silently shrink.
  days AS (
    SELECT generate_series(
             date_trunc('day', now() AT TIME ZONE 'UTC') - INTERVAL '6 days',
             date_trunc('day', now() AT TIME ZONE 'UTC'),
             INTERVAL '1 day'
           ) AS bucket
  ),
  -- Both order tables unioned ONCE, then counted a single time. Counting them
  -- separately is exactly what made the original loop two queries per day.
  all_orders AS (
    SELECT created_at FROM public.orders
    UNION ALL
    SELECT created_at FROM public.agent_orders
  ),
  per_day AS (
    SELECT d.bucket, count(o.created_at)::bigint AS n
      FROM days d
      LEFT JOIN all_orders o
        ON date_trunc('day', o.created_at AT TIME ZONE 'UTC') = d.bucket
     GROUP BY d.bucket
  )
SELECT
  (SELECT count(*)::bigint FROM public.orders)                            AS total_orders,
  (SELECT count(*)::bigint FROM public.agent_orders)                       AS total_agent_orders,
  (SELECT count(*)::bigint FROM public.offers)                             AS total_offers,
  (SELECT count(*)::bigint FROM public.agent_offers)                       AS total_agent_offers,
  (SELECT count(*)::bigint FROM public.orders WHERE status = 'pending')    AS pending_orders,
  (SELECT count(*)::bigint FROM public.agent_orders WHERE status = 'pending') AS pending_agent_orders,
  (SELECT count(*)::bigint FROM public.notifications)                      AS total_notifications,
  (SELECT count(*)::bigint
     FROM public.notifications
    WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  )                                                                       AS notifications_today,
  -- `array_agg ... ORDER BY bucket` guarantees oldest-first, which the chart
  -- depends on. The client loop ran `for (let i = 6; i >= 0; i--)`, i.e.
  -- backwards from today, so index 0 was the oldest day - preserved here.
  COALESCE(
    (SELECT array_agg(pd.n ORDER BY pd.bucket) FROM per_day pd),
    ARRAY[]::bigint[]
  )
$$;

REVOKE ALL ON FUNCTION public.admin_dashboard_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_stats() TO service_role;

COMMENT ON FUNCTION public.admin_dashboard_stats() IS
  'Single-round-trip aggregate for the admin dashboard. Replaces the 14-query sequential 7-day loop in DashboardScreen.fetchStats.';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Exactly one row, and `daily_counts` has 7 entries:
--
--   SELECT * FROM public.admin_dashboard_stats();
--
-- On a fresh install with zero orders, `daily_counts` must be {0,0,0,0,0,0,0} -
-- never an empty array, or the chart renders no bars and reports no error.
--
-- Cross-check against the direct counts:
--
--   SELECT
--     (SELECT count(*) FROM public.orders)                       AS total_orders,
--     (SELECT count(*) FROM public.agent_orders)                  AS total_agent_orders,
--     (SELECT count(*) FROM public.orders WHERE status='pending') AS pending_orders;
--
-- The LAST element of `daily_counts` is today's count, not a running total.
-- ---------------------------------------------------------------------------

COMMIT;
