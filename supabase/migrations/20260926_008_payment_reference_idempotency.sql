BEGIN;

-- ===========================================================================
-- Idempotency guards for payment references
-- ===========================================================================
-- `verify-payment` trusts a client-supplied `reference` and had no replay
-- guard. Nothing stopped the same call being made twice: a double-tap, a
-- retried request after a timeout, or a crafted request.
--
-- The consequences were real money, not a duplicate row:
--   - the wallet path calls `debit_super_agent_wallet` on every invocation, so
--     a replay debited the super agent's wallet twice for one purchase
--   - the Paystack path inserts a second `orders` / `agent_orders` row for a
--     single Paystack transaction, and each row is independently dispatchable
--     to the provider - so a replay can buy data twice
--
-- The correct fix is at the database level, not in the function: a function-
-- side check is a race, and two concurrent replays would both pass it. 
-- UNIQUE constraint makes exactly one of them win.
--
-- The unique indexes are added CONCURRENTLY-equivalent (as plain indexes, then
-- constraints) only if the columns have no duplicates today. Pre-existing
-- duplicates are reported rather than silently deleted - reconciling them is a
-- finance decision, not a migration's.

-- ---------------------------------------------------------------------------
-- Report duplicates BEFORE constraining
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.duplicate_payment_reference_report (
  table_name text NOT NULL,
  payment_reference text NOT NULL,
  row_count bigint NOT NULL,
  order_ids bigint[],
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, payment_reference)
);

COMMENT ON TABLE public.duplicate_payment_reference_report IS
  'Payment references that appear more than once within one order table. These BLOCK the unique index in migration 20260926_008 until a human resolves them.';

ALTER TABLE public.duplicate_payment_reference_report ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS duplicate_payment_reference_report_admin_read
  ON public.duplicate_payment_reference_report;
CREATE POLICY duplicate_payment_reference_report_admin_read
  ON public.duplicate_payment_reference_report
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('Admin', 'admin')
    OR (auth.jwt() -> 'app_metadata' ->> 'role') IN
       ('SuperAgent', 'superagent', 'super_agent')
  );

-- ---------------------------------------------------------------------------
-- agent_orders never had a payment_reference column
-- ---------------------------------------------------------------------------
-- This is the bug that made this migration fail on its second INSERT with:
--
--   ERROR: 42703: column "payment_reference" does not exist
--   HINT: There is a column named "payment_reference" in table
--         "duplicate_payment_reference_report", but it cannot be referenced
--         from this part of the query.
--
-- The HINT is misleading: the column genuinely does not exist on
-- agent_orders. `orders` got one in the base schema, but agent_orders was
-- never given the equivalent - and `verify-payment` does not write a
-- reference onto agent_orders either, so even the rows had nothing to store.
--
-- The consequence was not cosmetic. `verify-payment`'s replay guard looks the
-- reference up in BOTH tables, so its agent_orders branch was querying a
-- non-existent column. That silently did nothing, leaving the sub-agent path
-- with NO idempotency protection: a replayed call would debit the super
-- agent's wallet a second time for one purchase.
--
-- So the column is added here, and the function (see verify-payment) is
-- updated to actually populate it.
--
-- Nullable on purpose: existing rows are historical and cannot be given a
-- reference retroactively, and the partial index below ignores nulls.
ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS payment_reference text;

COMMENT ON COLUMN public.agent_orders.payment_reference IS
  'Paystack reference for this order. Added 20260926_008 so the sub-agent path has the same replay protection as orders. Historical rows are NULL.';

CREATE INDEX IF NOT EXISTS idx_agent_orders_payment_reference
  ON public.agent_orders (payment_reference)
  WHERE payment_reference IS NOT NULL;

INSERT INTO public.duplicate_payment_reference_report (
  table_name, payment_reference, row_count, order_ids
)
SELECT
  'orders',
  payment_reference,
  count(*)::bigint,
  array_agg(id ORDER BY id)
FROM public.orders
WHERE payment_reference IS NOT NULL
  AND btrim(payment_reference) <> ''
GROUP BY payment_reference
HAVING count(*) > 1
ON CONFLICT (table_name, payment_reference) DO UPDATE
SET row_count = EXCLUDED.row_count,
    order_ids = EXCLUDED.order_ids;

-- Safe to run now that the column exists. Every row is NULL today, so this
-- finds nothing - it exists so that the report is correct the moment
-- verify-payment starts populating the column.
INSERT INTO public.duplicate_payment_reference_report (
  table_name, payment_reference, row_count, order_ids
)
SELECT
  'agent_orders',
  payment_reference,
  count(*)::bigint,
  array_agg(id ORDER BY id)
FROM public.agent_orders
WHERE payment_reference IS NOT NULL
  AND btrim(payment_reference) <> ''
GROUP BY payment_reference
HAVING count(*) > 1
ON CONFLICT (table_name, payment_reference) DO UPDATE
SET row_count = EXCLUDED.row_count,
    order_ids = EXCLUDED.order_ids;

-- ---------------------------------------------------------------------------
-- Partial unique indexes
-- ---------------------------------------------------------------------------
-- PARTIAL (WHERE payment_reference IS NOT NULL) on purpose:
--   - wallet orders, admin-created orders and migrated rows can legitimately
--     carry a null reference, and a plain UNIQUE would allow only ONE null,
--     breaking all of them
--   - an empty string is not a real reference; the function rejects it
--
-- NULLS NOT DISTINCT is not used here because the partial predicate already
-- excludes nulls.
--
-- The duplicate count is recomputed from the TABLES, not read from
-- duplicate_payment_reference_report. The report is a snapshot: if this
-- migration is re-run after someone resolves a duplicate by hand, the stale
-- row would still block the index forever. Counting the live data means the
-- guard is always correct, and the report stays purely informational.

DO $$
DECLARE
  dup_count bigint;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT payment_reference
    FROM public.orders
    WHERE payment_reference IS NOT NULL
      AND btrim(payment_reference) <> ''
    GROUP BY payment_reference
    HAVING count(*) > 1
  ) duplicates;

  IF dup_count > 0 THEN
    RAISE WARNING
      'Skipping unique index on orders.payment_reference: % duplicate reference(s) found. See public.duplicate_payment_reference_report. Resolve them, then apply the index manually.',
      dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_orders_payment_reference_unique
      ON public.orders (payment_reference)
      WHERE payment_reference IS NOT NULL
        AND btrim(payment_reference) <> '';
    RAISE NOTICE 'Created unique index on orders.payment_reference';
  END IF;

  -- Recomputed, and scoped to agent_orders. The previous version read
  -- count(*) over the WHOLE report, so a duplicate in `orders` would also
  -- block the agent_orders index and vice versa.
  SELECT count(*) INTO dup_count
  FROM (
    SELECT payment_reference
    FROM public.agent_orders
    WHERE payment_reference IS NOT NULL
      AND btrim(payment_reference) <> ''
    GROUP BY payment_reference
    HAVING count(*) > 1
  ) duplicates;

  IF dup_count > 0 THEN
    RAISE WARNING
      'Skipping unique index on agent_orders.payment_reference: % duplicate reference(s) found. See public.duplicate_payment_reference_report.',
      dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_agent_orders_payment_reference_unique
      ON public.agent_orders (payment_reference)
      WHERE payment_reference IS NOT NULL
        AND btrim(payment_reference) <> '';
    RAISE NOTICE 'Created unique index on agent_orders.payment_reference';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- wallet_topups: already protected
-- ---------------------------------------------------------------------------
-- `wallet_topups.reference` is declared `text NOT NULL UNIQUE` in the base
-- schema, so `verify-wallet-topup` is already replay-safe and needs no change
-- here. Verified rather than assumed - if that constraint is ever dropped, the
-- top-up path becomes double-creditable and this needs revisiting.

-- ---------------------------------------------------------------------------
-- Human-readable outcome
-- ---------------------------------------------------------------------------
--   -- Did the guards actually land, or were they skipped for duplicates?
--   SELECT table_name, count(*) AS duplicate_references
--     FROM public.duplicate_payment_reference_report
--    GROUP BY table_name;
--
--   SELECT indexname FROM pg_indexes
--    WHERE indexname IN (
--      'idx_orders_payment_reference_unique',
--      'idx_agent_orders_payment_reference_unique'
--    );
--
--   -- Any duplicates NOT yet recorded (e.g. the report was truncated)?
--   SELECT payment_reference, count(*)
--     FROM public.orders
--    WHERE payment_reference IS NOT NULL AND btrim(payment_reference) <> ''
--    GROUP BY payment_reference HAVING count(*) > 1;

COMMIT;
