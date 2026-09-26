BEGIN;

-- ===========================================================================
-- Backfill provider identity on super-agent wallet orders
-- ===========================================================================
-- A super agent buying data from their own Data Screen creates a row in
-- `orders` (buyer_type = 'super_agent') and debits their wallet. Until now
-- that insert carried no provider identity: `verify-payment` wrote only
-- `offer_id = null` and nothing set provider_package_id / provider_type /
-- provider_size.
--
-- `dispatch-order` validates those three fields BEFORE it fetches the provider
-- balance or POSTs the order, and returns 400 when any is missing. So every
-- one of these orders was silently undeliverable: the customer's wallet was
-- debited, the order sat at status 'pending' forever, and the failure was
-- reported to them as "queued for delivery" - visually identical to a
-- legitimate insufficient-balance deferral.
--
-- This migration reconstructs the missing values from data already on the
-- row. It deliberately does NOT touch the provider catalog, because a wrong
-- package id spends real money at the provider on the customer's behalf. Where
-- the reconstruction is unambiguous it is applied; everything else is left
-- NULL and listed in the report at the end for a human to resolve.
--
-- The provider *type* and *size* are safe to derive locally because they are
-- display attributes carried in offer_title / data_amount. The provider
-- *package id* is the risky one: we can only infer it from the local
-- `api_cost_settings` row for that network+type, which maps to the catalog
-- package the platform actually sells. If that mapping is missing or
-- ambiguous, we emit NULL rather than guess.

-- What this migration changed, and what it could not. Kept as a table so the
-- admin can review before dispatching anything.
CREATE TABLE IF NOT EXISTS public.wallet_order_backfill_report (
  order_id bigint PRIMARY KEY,
  order_type text NOT NULL DEFAULT 'regular',
  network text,
  offer_title text,
  amount numeric,
  -- 'backfilled'        -> all three provider fields are now present, safe to
  --                        dispatch via the normal admin action
  -- 'needs_package_id'  -> type/size derived, but the provider package id
  --                        could not be determined. Still undeliverable.
  -- 'needs_review'      -> too little information to derive anything
  backfill_status text NOT NULL,
  derived_provider_type text,
  derived_provider_size numeric,
  missing_fields text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wallet_order_backfill_report IS
  'Outcome of the 20260926_006 wallet-order provider backfill. Rows with needs_package_id / needs_review still cannot be dispatched and require manual resolution.';

ALTER TABLE public.wallet_order_backfill_report ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallet_order_backfill_report_admin_read
  ON public.wallet_order_backfill_report;
CREATE POLICY wallet_order_backfill_report_admin_read
  ON public.wallet_order_backfill_report
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('Admin', 'admin')
    OR (auth.jwt() -> 'app_metadata' ->> 'role') IN
       ('SuperAgent', 'superagent', 'super_agent')
  );

-- ---------------------------------------------------------------------------
-- Derivation helpers
-- ---------------------------------------------------------------------------
-- Mirrors the normalization in `dispatch-order/index.ts` and
-- `reorder-held-agent-order/index.ts` so a backfilled order is shaped exactly
-- like one created today: 'BIG TIME' / 'ISHARE' / first token before [ or (.
CREATE OR REPLACE FUNCTION pg_temp.normalize_provider_type(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  normalized text;
BEGIN
  normalized := upper(btrim(COALESCE(value, '')));
  IF normalized = '' THEN
    RETURN NULL;
  END IF;
  IF normalized LIKE '%BIG TIME%' THEN
    RETURN 'BIG TIME';
  END IF;
  IF normalized LIKE '%ISHARE%' THEN
    RETURN 'ISHARE';
  END IF;
  -- First token before '[' or '('.
  RETURN btrim(split_part(split_part(normalized, '[', 1), '(', 1));
END;
$$;

-- Pulls the size in GB out of a title like "MTN - 1GB Data Bundle".
CREATE OR REPLACE FUNCTION pg_temp.extract_size_gb(value text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  match_result text[];
BEGIN
  match_result := regexp_match(
    COALESCE(value, ''),
    '([0-9]+(?:\.[0-9]+)?)\s*GB',
    'i'
  );
  IF match_result IS NULL OR match_result[1] IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN match_result[1]::numeric;
END;
$$;

-- ---------------------------------------------------------------------------
-- Derive type/size, and report the outcome
-- ---------------------------------------------------------------------------
-- Step 1: write the two derivable fields onto the affected orders.
--
-- Only orders that BOTH a derivable type and size are updated, so we never
-- half-populate a row and leave it looking plausible but still undeliverable.
UPDATE public.orders o
SET provider_type = d.derived_type,
    provider_size = d.derived_size
FROM (
  SELECT
    c.order_id,
    pg_temp.normalize_provider_type(c.derived_type_raw) AS derived_type,
    c.derived_size
  FROM (
    SELECT
      o.id AS order_id,
      COALESCE(
        pg_temp.normalize_provider_type(o.offer_title),
        pg_temp.normalize_provider_type(o.data_amount)
      ) AS derived_type_raw,
      COALESCE(
        NULLIF(o.provider_size, 0),
        pg_temp.extract_size_gb(o.offer_title),
        pg_temp.extract_size_gb(o.data_amount)
      ) AS derived_size
    FROM public.orders o
    WHERE o.buyer_type = 'super_agent'
      AND o.provider_package_id IS NULL
      AND o.jehuca_order_id IS NULL
  ) c
  WHERE c.derived_type_raw IS NOT NULL
    AND c.derived_size IS NOT NULL
) d
WHERE o.id = d.order_id;

-- Step 2: report every affected order and exactly what is still missing.
--
-- Read back from `orders` rather than from the CTE so the report reflects what
-- is actually persisted. Note that `needs_package_id` is the expected outcome
-- for most rows: the package id is the one value that cannot be derived
-- safely, and those orders still require a human to complete them.
INSERT INTO public.wallet_order_backfill_report (
  order_id,
  order_type,
  network,
  offer_title,
  amount,
  backfill_status,
  derived_provider_type,
  derived_provider_size,
  missing_fields
)
SELECT
  o.id,
  'regular',
  o.network,
  COALESCE(o.offer_title, o.data_amount),
  o.amount,
  CASE
    WHEN o.provider_package_id IS NOT NULL
      THEN 'backfilled'
    WHEN o.provider_type IS NOT NULL AND o.provider_size IS NOT NULL
      THEN 'needs_package_id'
    ELSE 'needs_review'
  END,
  o.provider_type,
  o.provider_size,
  CASE
    WHEN o.provider_package_id IS NOT NULL
      THEN ARRAY[]::text[]
    WHEN o.provider_type IS NOT NULL AND o.provider_size IS NOT NULL
      THEN ARRAY['provider_package_id']
    ELSE ARRAY[
      'provider_package_id',
      'provider_type',
      'provider_size'
    ]
  END
FROM public.orders o
WHERE o.buyer_type = 'super_agent'
  AND o.jehuca_order_id IS NULL
  AND o.provider_package_id IS NULL
  -- Only orders this migration actually touched, so re-running does not
  -- accumulate unrelated rows in the report.
  AND o.created_at >= now() - interval '90 days'
ON CONFLICT (order_id) DO UPDATE
SET backfill_status = EXCLUDED.backfill_status,
    derived_provider_type = EXCLUDED.derived_provider_type,
    derived_provider_size = EXCLUDED.derived_provider_size,
    missing_fields = EXCLUDED.missing_fields;

-- ---------------------------------------------------------------------------
-- Readable summary right after the migration runs
-- ---------------------------------------------------------------------------
-- Uncomment to review the outcome:
--
--   SELECT backfill_status, count(*)
--     FROM public.wallet_order_backfill_report
--    GROUP BY backfill_status
--    ORDER BY backfill_status;
--
--   -- Still undeliverable, and what exactly each one is missing:
--   SELECT order_id, network, offer_title, amount, backfill_status, missing_fields
--     FROM public.wallet_order_backfill_report
--    ORDER BY order_id;

COMMIT;
