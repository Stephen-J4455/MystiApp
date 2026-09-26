BEGIN;

-- ===========================================================================
-- Durable edge function invocation log
-- ===========================================================================
-- Every edge function invocation writes one row here via
-- `_shared/logger.ts`, so the admin app can see what each call did.
--
-- WHY THIS IS NOT JUST THE PLATFORM LOG DRAIN
-- -------------------------------------------
-- Supabase already captures `console.log` output, but it is only reachable
-- through the hosted log explorer, not from the admin app. That gap is exactly
-- what let the wallet-order dispatch bug hide: `dispatch-order` returned 400,
-- the client reported it to the customer as "queued for delivery", and the
-- resulting order row was indistinguishable from a legitimately deferred one.
-- Nobody had a place to look that would have shown the mismatch.
--
-- PRIVACY
-- -------
-- `detail` is written by the logger AFTER redaction: authorization headers,
-- API keys and tokens are dropped entirely; phone numbers, emails, names and
-- payment references are masked to a length-and-prefix form. Numeric fields
-- (order ids, amounts, sizes) are kept verbatim because they are what make a
-- row actionable. Do not add columns here expecting to write raw request
-- bodies - write a redacted summary.
--
-- RETENTION
-- ---------
-- Uncomment the purge below and schedule it (pg_cron, or a Supabase scheduled
-- invocation) to keep the table bounded. Nothing prunes it automatically.

CREATE TABLE IF NOT EXISTS public.edge_function_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Which edge function handled the call.
  function_name text NOT NULL,

  -- Correlates every row produced by one logical operation, so a purchase and
  -- the dispatch it triggers can be read together. Echoed from an inbound
  -- `x-request-id` header when the client sends one.
  request_id text NOT NULL,

  -- The authenticated caller, when there was one. NULL for preflight and for
  -- calls that failed before authentication resolved.
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- The RESOLVED role from `user_profiles`, not from user metadata. Kept
  -- denormalized so a log row still explains itself after a role change.
  user_role text,

  method text NOT NULL,
  status_code integer NOT NULL,

  duration_ms integer,

  -- See `classifyStatus` in _shared/logger.ts. `provider_deferred` (retryable,
  -- provider unreachable or unfunded) is deliberately distinct from
  -- `provider_rejected` (the provider declined it).
  error_kind text NOT NULL DEFAULT 'ok'
    CHECK (error_kind IN (
      'ok',
      'unauthorized',
      'forbidden',
      'validation',
      'not_found',
      'conflict',
      'provider_deferred',
      'provider_rejected',
      'rate_limited',
      'internal'
    )),

  -- Redacted request/response summary. See the privacy note above.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The admin app's primary view: newest first, optionally filtered by function.
CREATE INDEX IF NOT EXISTS idx_edge_function_logs_function_created
  ON public.edge_function_logs (function_name, created_at DESC);

-- Cross-function timeline.
CREATE INDEX IF NOT EXISTS idx_edge_function_logs_created
  ON public.edge_function_logs (created_at DESC);

-- Trace lookup.
CREATE INDEX IF NOT EXISTS idx_edge_function_logs_request
  ON public.edge_function_logs (request_id);

-- "What is failing right now" - the error pane's main query.
CREATE INDEX IF NOT EXISTS idx_edge_function_logs_error_kind
  ON public.edge_function_logs (error_kind, created_at DESC)
  WHERE error_kind <> 'ok';

-- Per-caller activity.
CREATE INDEX IF NOT EXISTS idx_edge_function_logs_user
  ON public.edge_function_logs (user_id, created_at DESC);

ALTER TABLE public.edge_function_logs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Access policy
-- ---------------------------------------------------------------------------
-- Two legs only:
--   1. Platform admins and super agents may READ (the admin app screen).
--   2. The service role may INSERT (the logger).
--
-- There is deliberately NO policy granting UPDATE or DELETE to `authenticated`.
-- A log that an admin can edit is not evidence, and a log any authenticated
-- user can delete is not a record. Retention is handled by the service role
-- (see the purge note at the end of this file).
--
-- Note the `app_metadata` leg only. `auth.jwt() -> 'user_metadata'` is
-- user-writable, so a policy built on it would be self-service escalation -
-- the same flaw this migration's companion `_shared/auth.ts` removes from the
-- edge functions. Migrations 20260925_001 and 20260926_005 still contain
-- `user_metadata` legs and should be tightened separately.

DROP POLICY IF EXISTS edge_function_logs_admin_read
  ON public.edge_function_logs;
CREATE POLICY edge_function_logs_admin_read
  ON public.edge_function_logs
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('Admin', 'admin')
    OR (auth.jwt() -> 'app_metadata' ->> 'role') IN
       ('SuperAgent', 'superagent', 'super_agent')
  );

DROP POLICY IF EXISTS edge_function_logs_service_insert
  ON public.edge_function_logs;
CREATE POLICY edge_function_logs_service_insert
  ON public.edge_function_logs
  FOR INSERT TO service_role
  WITH CHECK (true);

-- Belt and braces: even if a stray policy is added later, the service role
-- must be the only role able to write.
REVOKE INSERT, UPDATE, DELETE ON public.edge_function_logs FROM authenticated;
REVOKE ALL ON public.edge_function_logs FROM anon;
GRANT SELECT ON public.edge_function_logs TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.edge_function_logs TO service_role;

-- ---------------------------------------------------------------------------
-- Optional: admin aggregates
-- ---------------------------------------------------------------------------
-- A compact "is anything failing" rollup for a dashboard tile. Safe because it
-- is SECURITY DEFINER with a fixed search_path and grants nothing extra.
CREATE OR REPLACE FUNCTION public.get_edge_function_log_summary(
  p_function_name text DEFAULT NULL,
  p_hours integer DEFAULT 24
)
RETURNS TABLE (
  function_name text,
  error_kind text,
  call_count bigint,
  avg_duration_ms numeric,
  p95_duration_ms numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.function_name,
    l.error_kind,
    count(*)::bigint AS call_count,
    round(avg(l.duration_ms)::numeric, 1) AS avg_duration_ms,
    round(
      percentile_cont(0.95) WITHIN GROUP (ORDER BY l.duration_ms)::numeric,
      1
    ) AS p95_duration_ms
  FROM public.edge_function_logs l
  WHERE l.created_at >= now() - (make_interval(mins => p_hours))
    AND (p_function_name IS NULL OR l.function_name = p_function_name)
  GROUP BY l.function_name, l.error_kind
  ORDER BY l.function_name, call_count DESC;
$$;

REVOKE ALL ON FUNCTION public.get_edge_function_log_summary(text, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_edge_function_log_summary(text, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Optional retention purge
-- ---------------------------------------------------------------------------
-- Not scheduled automatically - it needs pg_cron, which may not be enabled.
-- Create it and run it from a Supabase scheduled invocation:
--
--   DELETE FROM public.edge_function_logs WHERE created_at < now() - interval '30 days';
--
-- Run it as the service role. No authenticated policy can delete, by design.

COMMIT;
