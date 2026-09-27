BEGIN;

-- ===========================================================================
-- Record the Paystack charge on a wallet top-up
-- ===========================================================================
-- WHAT IS WRONG TODAY
-- ------------------
-- `wallet_topups.amount` is the NET figure: the amount the wallet should be
-- credited. The GROSS charged by Paystack (net + `wallet_topup_percent`%) was
-- computed in the client and never persisted anywhere.
--
-- That leaves two concrete problems:
--
--   1. Nothing recorded what the platform actually collected on a top-up, so
--      the fee is invisible in every report. The admin wallet view reconciles
--      against Paystack and the two numbers simply cannot be tied together.
--
--   2. Nothing recorded WHICH rate applied. The percent is read live from
--      `payment_charge_settings` at verification time, so editing that row
--      retroactively changes the fee that should be attributed to every
--      historical top-up. This is the same immutability rule already applied
--      to `api_cost` on orders (see pricing-and-margin.md): a snapshot is
--      taken at purchase time and never rewritten.
--
-- This migration only ADDS columns. It backfills nothing: the gross is
-- recomputable from `amount` for historical rows, but the rate that was
-- actually in force at the time is not recoverable, so backfilling would
-- fabricate a number. The columns are nullable and NULL reads as "not
-- recorded", which is honest.
--
-- The 1.95% is charged ONCE, at top-up. It is deliberately NOT applied again
-- per order - the wallet is credited net, so re-charging it at purchase time
-- would take the same money twice.

-- The net amount, already present as `amount`. Documented here because the
-- relationship between the three columns is the whole point of this migration.
COMMENT ON COLUMN public.wallet_topups.amount IS
  'NET amount credited to the wallet. Paystack was charged gross_amount instead.';

-- What Paystack actually collected, in the same currency/unit as `amount`.
ALTER TABLE public.wallet_topups
  ADD COLUMN IF NOT EXISTS gross_amount numeric;

COMMENT ON COLUMN public.wallet_topups.gross_amount IS
  'Total Paystack charged for this top-up, including the transaction charge. Null for rows settled before this migration - the figure was never persisted.';

-- The charge itself, so it can be reconciled without re-deriving it from two
-- rounded numbers (which is lossy: 100 + 1.95 and 1.95 + 0.01 disagree).
ALTER TABLE public.wallet_topups
  ADD COLUMN IF NOT EXISTS charge_amount numeric;

COMMENT ON COLUMN public.wallet_topups.charge_amount IS
  'Paystack transaction charge in effect for this top-up. Null for rows settled before this migration.';

-- The rate as a percentage, snapshotted. A percentage, not a fraction, to
-- match `payment_charge_settings.*_percent`.
ALTER TABLE public.wallet_topups
  ADD COLUMN IF NOT EXISTS charge_percent numeric;

COMMENT ON COLUMN public.wallet_topups.charge_percent IS
  'Snapshot of payment_charge_settings.wallet_topup_percent as a percentage at settlement time. Never rewritten when the setting is later changed.';

-- ---------------------------------------------------------------------------
-- Integrity
-- ---------------------------------------------------------------------------
-- Only on rows that actually recorded all three figures. A CHECK that
-- references a NULL evaluates to NULL, which passes, so historical rows with
-- no snapshot are unaffected - which is the intent. The tolerance absorbs
-- float/rounding drift only; the fee is rounded to 2dp on both sides.
ALTER TABLE public.wallet_topups
  DROP CONSTRAINT IF EXISTS wallet_topups_charge_consistent;

ALTER TABLE public.wallet_topups
  ADD CONSTRAINT wallet_topups_charge_consistent
  CHECK (
    charge_amount IS NULL
    OR gross_amount IS NULL
    OR charge_percent IS NULL
    OR abs(gross_amount - (amount + charge_amount)) <= 0.01
  );

-- The reconciliation query reads settled top-ups for a super agent in a date
-- range and groups on agent_id, so this partial index matches it exactly.
CREATE INDEX IF NOT EXISTS idx_wallet_topups_gross_reconciliation
  ON public.wallet_topups (agent_id, created_at DESC)
  WHERE status = 'success';

COMMIT;
