BEGIN;

-- ===========================================================================
-- Expire stale held agent orders after 24 hours
-- ===========================================================================
-- A `held` agent order is NOT an unpaid order. In `verify-payment` the
-- sub-agent's Paystack payment is verified and CAPTURED first (`paid_at` and
-- `paystack_transaction_id` are written to the row), and only then is the
-- super agent's wallet debited. `held` therefore means:
--
--     "The customer already paid. Our internal ledger debit to the super
--      agent failed, so the order is parked until the wallet is funded."
--
-- These orders then sat in `held` forever: nothing expired them, no cron and
-- no sweep existed, and the only affordance was a "Reorder" button. Dead rows
-- accumulated indefinitely, and customers waiting on a delivery that could
-- not happen had no way to watch the order give up.
--
-- DELIBERATE DEVIATION FROM THE REQUEST
-- -------------------------------------
-- The request was to "remove" held orders after 24h. This EXPIRES them
-- (status 'held' -> 'expired') rather than DELETEing them. Each such row is the
-- only evidence that a real customer paid real money: `paid_at`,
-- `paystack_transaction_id` and `payment_reference` live on that row, and
-- `payment_reference` is what a Paystack refund is keyed on. A hard delete
-- would destroy the ability to refund the customer or reconcile against
-- Paystack, and would be irreversible.
--
-- Expiry achieves the operational goal - the order leaves every active queue
-- and the super agent stops seeing it as actionable - while keeping the
-- record. If you do want these rows gone afterwards, that should be a
-- separate, deliberate retention decision applied to the expiry log, not
-- folded into this sweep.
--
-- No money moves here. See section 5 for why refunds are flagged, not issued.

-- ---------------------------------------------------------------------------
-- 1. Expiry bookkeeping columns
-- ---------------------------------------------------------------------------
-- The deadline is stored rather than recomputed from created_at on every read
-- so the UI countdown and this sweep agree on when it is, and so the window
-- can be adjusted per-order (a support agent extending a deadline) without
-- rewriting created_at.
ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS held_at timestamptz;

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS held_expires_at timestamptz;

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS expiry_reason text;

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS refund_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.agent_orders.held_at IS
  'When this order entered the held state. Cleared when it leaves held.';
COMMENT ON COLUMN public.agent_orders.held_expires_at IS
  'Deadline after which the expiry sweep may expire this order. Set to held_at + 24h when first held.';
COMMENT ON COLUMN public.agent_orders.expired_at IS
  'When public.expire_stale_held_agent_orders() expired this order.';
COMMENT ON COLUMN public.agent_orders.expiry_reason IS
  'Why the order was expired, e.g. held_window_elapsed.';
COMMENT ON COLUMN public.agent_orders.refund_required IS
  'True when the customer already paid but the order can no longer be fulfilled, so a Paystack refund is owed. Set by the expiry sweep, never by a customer.';

-- Partial on the sweep's predicate, so the index stays small even though held
-- orders are a tiny fraction of the table.
CREATE INDEX IF NOT EXISTS idx_agent_orders_held_expiry
  ON public.agent_orders (held_expires_at)
  WHERE status = 'held';

-- ---------------------------------------------------------------------------
-- 2. Audit log of every expiry
-- ---------------------------------------------------------------------------
-- A separate table rather than relying on the order row alone. "Which
-- customers had an order expire, and what do I owe them" has to stay
-- answerable even if the order row is later archived or purged.
CREATE TABLE IF NOT EXISTS public.held_order_expiry_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL,
  expired_at timestamptz NOT NULL DEFAULT now(),
  agent_id uuid,
  super_agent_id uuid,
  order_created_at timestamptz,
  held_since timestamptz,
  amount numeric,
  base_amount numeric,
  recipient_phone text,
  payment_reference text,
  paystack_transaction_id text,
  paid_at timestamptz,
  reason text NOT NULL DEFAULT 'held_window_elapsed',
  refund_required boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE public.held_order_expiry_log IS
  'One row per held agent order expired by public.expire_stale_held_agent_orders(). Captures the payment identifiers needed to issue a Paystack refund.';

CREATE INDEX IF NOT EXISTS idx_held_expiry_log_super_agent
  ON public.held_order_expiry_log (super_agent_id, expired_at DESC);

-- Partial index over the outstanding-refund queue: the common query is "what
-- do I still owe", which only ever reads rows where refund_required is true.
CREATE INDEX IF NOT EXISTS idx_held_expiry_log_refund_outstanding
  ON public.held_order_expiry_log (expired_at DESC)
  WHERE refund_required;

ALTER TABLE public.held_order_expiry_log ENABLE ROW LEVEL SECURITY;

-- Read access for the refund queue. No INSERT/UPDATE/DELETE policy is created
-- on purpose: this table is written only by the sweep function below, which
-- runs as its definer. Making it client-writable would let anyone forge or
-- erase refund evidence.
DROP POLICY IF EXISTS held_order_expiry_log_staff_read
  ON public.held_order_expiry_log;
CREATE POLICY held_order_expiry_log_staff_read
  ON public.held_order_expiry_log
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('Admin', 'admin')
    OR (auth.jwt() -> 'app_metadata' ->> 'role') IN
       ('SuperAgent', 'superagent', 'super_agent')
  );

-- ---------------------------------------------------------------------------
-- 3. Arm the 24h deadline when an order enters `held`
-- ---------------------------------------------------------------------------
-- A trigger rather than an edit to verify-payment, so the deadline is armed
-- wherever the transition happens, and so pre-existing held rows (which have
-- no deadline and would otherwise be permanently un-expirable) get one.
--
-- The window is measured from the moment of the hold, NOT from created_at. A
-- customer whose payment verified at 23:59 has barely used their window;
-- measuring from created_at would expire them almost immediately.
CREATE OR REPLACE FUNCTION public.arm_agent_order_hold_deadline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Preserve an existing deadline. Re-saving the row (the reorder flow
  -- touching settlement columns, an admin edit) must not silently hand a
  -- customer another 24h.
  IF NEW.held_expires_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  NEW.held_at := COALESCE(NEW.held_at, now());
  NEW.held_expires_at := NEW.held_at + interval '24 hours';
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.arm_agent_order_hold_deadline() IS
  'Arms held_at / held_expires_at on agent_orders. The 24h window runs from the hold, not from created_at.';

DROP TRIGGER IF EXISTS trg_agent_order_hold_deadline ON public.agent_orders;

-- WHEN (NEW.status = 'held') is load-bearing, not an optimisation. Without it
-- the trigger also fires on updates to rows that are already held, and the
-- `held_expires_at IS NOT NULL` guard would be the only thing holding the
-- deadline steady. Confining the logic to the actual transition makes the
-- intent obvious and keeps the hot path cheap.
CREATE TRIGGER trg_agent_order_hold_deadline
  BEFORE INSERT OR UPDATE OF status ON public.agent_orders
  FOR EACH ROW
  WHEN (NEW.status = 'held')
  EXECUTE FUNCTION public.arm_agent_order_hold_deadline();

-- ---------------------------------------------------------------------------
-- 4. Backfill deadlines for orders already held
-- ---------------------------------------------------------------------------
-- Without this, every pre-existing held row has held_expires_at = NULL, never
-- matches the sweep's predicate, and stays stuck in `held` forever - the exact
-- bug this migration exists to fix, still present on day one.
--
-- The deadline is created_at + 24h so the rule is applied consistently, with a
-- floor of now() + 24h for rows held longer than 24h already. An order held
-- for three weeks is not owed a fresh 24h from deployment, but it is equally
-- not entitled to vanish the instant the migration runs: a full day keeps the
-- change safe to apply against live traffic.
DO $$
DECLARE
  backfilled bigint;
BEGIN
  UPDATE public.agent_orders
     SET held_at = COALESCE(held_at, created_at),
         held_expires_at = GREATEST(
           COALESCE(held_at, created_at) + interval '24 hours',
           now() + interval '24 hours'
         )
   WHERE status = 'held'
     AND held_expires_at IS NULL;

  GET DIAGNOSTICS backfilled = ROW_COUNT;
  IF backfilled > 0 THEN
    RAISE NOTICE 'Armed % pre-existing held agent order(s) with a 24h deadline', backfilled;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The sweep
-- ---------------------------------------------------------------------------
-- Concurrency: candidate rows are locked FOR UPDATE SKIP LOCKED and the
-- `status = 'held'` predicate is re-checked under that lock. A row that
-- `reorder-held-agent-order` is concurrently funding is therefore either
-- skipped, or found no longer held, and can never be expired out from under a
-- successful reorder.
--
-- Refunds are NOT issued here. Every candidate has a captured payment, but
-- sub-agent money routes to the super agent's Paystack SUBACCOUNT, so a
-- refund has to come out of that subaccount and may need the super agent's
-- consent. No Paystack refund path exists in this repo. A scheduled job
-- silently moving customer money is the wrong default, so the sweep records
-- `refund_required` and staff action it.
CREATE OR REPLACE FUNCTION public.expire_stale_held_agent_orders(
  p_hold_window interval DEFAULT interval '24 hours',
  p_max_batch integer DEFAULT 500,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  candidate record;
  expired_count integer := 0;
  refund_count integer := 0;
BEGIN
  IF p_hold_window <= interval '0' THEN
    RAISE EXCEPTION 'p_hold_window must be positive';
  END IF;

  IF p_max_batch <= 0 THEN
    RAISE EXCEPTION 'p_max_batch must be positive';
  END IF;

  -- A held row can still be missing a deadline if it was written by a path
  -- that bypassed the trigger. Arm it to the full window from now rather than
  -- treating a NULL deadline as "expired" - an unarmed row deserves the same
  -- courtesy a customer gets today, and treating NULL as expired would let a
  -- bug in the trigger silently expire orders instantly.
  UPDATE public.agent_orders
     SET held_at = COALESCE(held_at, now()),
         held_expires_at = now() + p_hold_window
   WHERE id IN (
     SELECT id
       FROM public.agent_orders
      WHERE status = 'held'
        AND held_expires_at IS NULL
      ORDER BY created_at
      LIMIT p_max_batch
   );

  FOR candidate IN
    SELECT id
      FROM public.agent_orders
     WHERE status = 'held'
       AND held_expires_at IS NOT NULL
       AND held_expires_at <= now()
     ORDER BY held_expires_at
     -- Bounded so a first run against a large backlog does not lock every
     -- held row in one long transaction. The next run drains the remainder.
     LIMIT p_max_batch
     FOR UPDATE SKIP LOCKED
  LOOP
    -- Re-check under the lock. SKIP LOCKED means we may have been reading a
    -- row that a concurrent reorder has since moved out of 'held'.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1
        FROM public.agent_orders
       WHERE id = candidate.id
         AND status = 'held'
         FOR UPDATE
    );

    IF p_dry_run THEN
      expired_count := expired_count + 1;
      CONTINUE;
    END IF;

    -- Snapshot the payment identifiers into the audit log before the row
    -- changes status. refund_required is true only when the customer paid AND
    -- no wallet debit ever landed for this order; a partially-landed debit is
    -- a separate reconciliation concern and is deliberately not auto-resolved.
    INSERT INTO public.held_order_expiry_log (
      order_id,
      agent_id,
      super_agent_id,
      order_created_at,
      held_since,
      amount,
      base_amount,
      recipient_phone,
      payment_reference,
      paystack_transaction_id,
      paid_at,
      reason,
      refund_required
    )
    SELECT
      o.id,
      o.agent_id,
      o.super_agent_id,
      o.created_at,
      o.held_at,
      o.amount,
      o.base_amount,
      o.recipient_phone,
      o.payment_reference,
      o.paystack_transaction_id,
      o.paid_at,
      'held_window_elapsed',
      (
        o.paid_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM public.super_agent_wallet_ledger AS ledger
           WHERE ledger.order_id = o.id
             AND ledger.entry_type = 'debit'
             AND ledger.amount < 0
        )
      )
    FROM public.agent_orders AS o
    WHERE o.id = candidate.id;

    UPDATE public.agent_orders
       SET status = 'expired',
           transaction_status = 'hold_window_elapsed',
           expired_at = now(),
           expiry_reason = 'held_window_elapsed',
           refund_required = (
             o.paid_at IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM public.super_agent_wallet_ledger AS ledger
                WHERE ledger.order_id = o.id
                  AND ledger.entry_type = 'debit'
                  AND ledger.amount < 0
             )
           ),
           -- Clear the hold clock so the order no longer shows a live
           -- countdown in the UI once it has expired.
           held_at = NULL,
           held_expires_at = NULL,
           settlement_status = 'failed'
      FROM public.agent_orders AS o
     WHERE o.id = candidate.id
       AND o.status = 'held';

    IF FOUND THEN
      expired_count := expired_count + 1;
      IF (SELECT refund_required
            FROM public.agent_orders
           WHERE id = candidate.id) THEN
        refund_count := refund_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'dry_run', p_dry_run,
    'hold_window', p_hold_window,
    'expired_count', expired_count,
    'refund_required_count', refund_count,
    'note',
      'Held orders are expired, never deleted: the row is the only record that the customer paid. Refunds are flagged for manual action, not issued automatically.'
  );
END;
$$;

COMMENT ON FUNCTION public.expire_stale_held_agent_orders(interval, integer, boolean) IS
  'Expires agent orders stuck in held beyond their 24h window. Never deletes. Use p_dry_run to preview.';

-- service_role only. pg_cron runs as the database owner and is the intended
-- caller; revoking PUBLIC stops a client from triggering the sweep.
REVOKE ALL ON FUNCTION public.expire_stale_held_agent_orders(interval, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_stale_held_agent_orders(interval, integer, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Scheduling
-- ---------------------------------------------------------------------------
-- pg_cron is not used anywhere else in this repo and is not installed on every
-- Supabase project, so the extension is created in its own block that swallows
-- the failure. The schedule is then applied only if the extension is present.
-- Either way this migration applies cleanly, and the function works: if no
-- schedule exists, call it manually or wire it up in Dashboard > Cron Jobs.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron unavailable - schedule expire_stale_held_agent_orders() manually';
  END;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule first so re-running this migration is idempotent rather than
    -- stacking duplicate hourly jobs that each expire a batch.
    IF EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'expire-stale-held-agent-orders'
    ) THEN
      PERFORM cron.unschedule('expire-stale-held-agent-orders');
    END IF;

    -- DO NOT write a dollar-quote delimiter anywhere inside this block, not
    -- even inside a comment. Postgres ends the body on the first such
    -- delimiter it sees, so a comment that merely MENTIONS one would truncate
    -- this block and fail pointing at the comment's own words - which is
    -- nowhere near the real cause. The schedule command below is therefore a
    -- plain single-quoted string.
    PERFORM cron.schedule(
      'expire-stale-held-agent-orders',
      '7 * * * *',
      'SELECT public.expire_stale_held_agent_orders()'
    );
    RAISE NOTICE 'Scheduled expire-stale-held-agent-orders hourly';
  ELSE
    RAISE NOTICE 'pg_cron not installed - schedule expire_stale_held_agent_orders() manually';
  END IF;
END;
$$;

COMMIT;
