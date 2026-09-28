BEGIN;

-- ===========================================================================
-- Seed sub-agent wallet mirrors from their real top-up history
-- ===========================================================================
-- DEPENDS ON: 20260928_008 (sub-agent wallet rows exist)
-- APPLY AFTER: 007, 008, 010, 009
--
-- WHY
-- ---
-- Migration 008 gave every sub-agent a `super_agent_wallets` row at balance 0,
-- deliberately, because seeding it from the super agent's balance would mint
-- spending power that no sub-agent had paid for. But that leaves the mirror
-- wrong in the other direction: a sub-agent who genuinely PAID for their
-- spending power before the mirror existed would see Ghc 0.00 and be unable
-- to buy anything, despite having funded their super agent's wallet with real
-- money.
--
-- So the mirror is seeded from the sub-agent's OWN history: what they paid in,
-- minus what they have already spent.
--
-- WHAT IS SEEDED
-- --------------
--   target = (sum of SUCCESSFUL top-ups by this sub-agent)
--          - (every wallet debit backing an order this sub-agent placed)
--
-- Both figures are net of the 1.95%. `wallet_topups.amount` is the NET the
-- super agent's wallet was credited, and the debits are the NET the wallet
-- was charged for an order, so the two are directly comparable. Seeding from
-- `gross_amount` instead would hand each sub-agent 1.95% of free spending
-- power and break the mirror invariant on day one.
--
-- WHY THE LEDGER, NOT `orders`
-- -----------------------------
-- An order is only money if the wallet was actually debited for it. A `held`
-- order is one whose debit FAILED - the order exists, no money moved. Summing
-- `orders.amount` would subtract spending the sub-agent never did.
-- `super_agent_wallet_ledger` records debits that really happened, so it is
-- the honest source.
--
-- `reason` is deliberately NOT used as a filter. Nothing in this codebase has
-- ever filtered on it, and admin debits (`admin_debit_super_agent_wallet`)
-- write their own free-text reason. `order_id IS NOT NULL` plus membership of
-- the sub-agent's own orders is what identifies a wallet purchase.
--
-- WHY A COMPUTED ASSIGNMENT, NOT AN INCREMENT
-- ------------------------------------------
-- The production functions may already have created mirror credits and debits
-- for a sub-agent who topped up or ordered after the last deploy. The target is
-- therefore recomputed from the FULL history on every run - every successful
-- top-up they ever made, minus every wallet debit backing an order they ever
-- placed - so post-deploy activity is already inside both terms and is neither
-- discarded nor double-counted.
--
-- An increment would be wrong in both directions: adding a post-deploy mirror
-- debit as an increment would count it twice, and adding a post-deploy top-up
-- without its matching debit would inflate the balance.
--
-- SAFE / NON-DESTRUCTIVE
-- ----------------------
-- The target is recomputed from immutable history, so re-running is stable and
-- converges. A balance is never pushed below zero - it is floored, and every
-- floored row is reported by the verify query rather than hidden. No top-up,
-- order, ledger row or status is modified.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The seed computation, in ONE place
-- ---------------------------------------------------------------------------
-- This was originally written twice - once for the report, once for the UPDATE
-- - and the two had already drifted: the second still carried a
-- `buyer_type = 'super_agent'` filter the first had lost, so the number that
-- was reported and the number that was written were computed by different SQL.
-- On a migration that sets a money balance, one definition of the truth is not
-- enough, so the computation is a view and every statement below reads it.
CREATE OR REPLACE VIEW public.sub_agent_mirror_seed AS
SELECT p.id                                    AS sub_agent_id,
       p.super_agent_id,
       COALESCE(t.paid_in, 0)                  AS paid_in,
       COALESCE(s.spent, 0)                    AS spent,
       GREATEST(0, COALESCE(t.paid_in, 0) - COALESCE(s.spent, 0))
                                                AS target_balance
  FROM public.user_profiles AS p
  LEFT JOIN LATERAL (
    SELECT SUM(t2.amount) AS paid_in
      FROM public.wallet_topups AS t2
     WHERE t2.agent_id = p.id
       AND t2.status = 'success'
  ) AS t ON TRUE
  LEFT JOIN LATERAL (
    -- Every wallet debit backing an order THIS sub-agent placed, whoever the
    -- wallet belonged to. `agent_orders` is included as well as `orders`,
    -- because a sub-agent has TWO spend paths:
    --
    --   1. wallet_order -> `orders`,       debited the full package price.
    --   2. Paystack     -> `agent_orders`, debited
    --      `settlement.baseAmount` - the BASE cost, not the sale price.
    --
    -- Matching only `orders` counts path 1 and silently misses path 2, seeding
    -- a sub-agent with spending power they have already spent. The two amounts
    -- differ, so that is not a rounding detail.
    --
    -- `buyer_type` is deliberately NOT filtered: it is NULLABLE and was added by
    -- 20260924_004, so any order predating that migration has NULL there and
    -- would be dropped. The wallet debit existing for the order is the real
    -- evidence it was a wallet purchase.
    SELECT SUM(-l.amount) AS spent
      FROM public.super_agent_wallet_ledger AS l
     WHERE l.entry_type = 'debit'
       AND l.order_id IS NOT NULL
       AND l.super_agent_id IN (p.id, p.super_agent_id)
       AND (
         l.order_id IN (
           SELECT o.id FROM public.orders AS o WHERE o.user_id = p.id
         )
         OR l.order_id IN (
           SELECT a.id FROM public.agent_orders AS a WHERE a.agent_id = p.id
         )
       )
  ) AS s ON TRUE
 WHERE lower(btrim(COALESCE(p.role, ''))) IN ('sub_agent', 'subagent')
   AND p.super_agent_id IS NOT NULL;

COMMENT ON VIEW public.sub_agent_mirror_seed IS
  'What each sub-agents mirrored wallet balance SHOULD be: their successful top-ups minus every wallet debit backing an order they placed. target_balance is floored at 0; a negative raw difference is a real shortfall.';

-- ---------------------------------------------------------------------------
-- 2. Report BEFORE applying, so the numbers land in the migration log
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT s.sub_agent_id, s.paid_in, s.spent, s.target_balance,
           COALESCE(w.balance, 0) AS current_balance
      FROM public.sub_agent_mirror_seed AS s
      LEFT JOIN public.super_agent_wallets AS w
        ON w.super_agent_id = s.sub_agent_id
  LOOP
    IF v_row.target_balance <> v_row.current_balance THEN
      RAISE NOTICE
        'seed % : current % -> target % (paid_in %, spent %)',
        v_row.sub_agent_id, v_row.current_balance, v_row.target_balance,
        v_row.paid_in, v_row.spent;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Apply
-- ---------------------------------------------------------------------------
-- New rows, for a sub-agent who has none yet, at their target.
INSERT INTO public.super_agent_wallets (super_agent_id, balance)
SELECT s.sub_agent_id, s.target_balance
  FROM public.sub_agent_mirror_seed AS s
 WHERE s.target_balance > 0
   AND NOT EXISTS (
     SELECT 1
       FROM public.super_agent_wallets AS w
      WHERE w.super_agent_id = s.sub_agent_id
   )
ON CONFLICT (super_agent_id) DO NOTHING;

-- Existing rows: set the target directly.
--
-- `GREATEST(0, ...)` is already applied inside the view, so this floors the
-- result rather than aborting on the table's CHECK (balance >= 0) and taking
-- the RLS fix in 008 down with it. Every floored row is a genuine shortfall and
-- is surfaced by the verify query below rather than silently hidden.
UPDATE public.super_agent_wallets AS w
   SET balance = s.target_balance,
       updated_at = now()
  FROM public.sub_agent_mirror_seed AS s
 WHERE w.super_agent_id = s.sub_agent_id
   AND w.balance <> s.target_balance;

-- ---------------------------------------------------------------------------
-- 4. Verify
-- ---------------------------------------------------------------------------
-- Every seeded balance now equals the target the view computed:
--
--   SELECT s.sub_agent_id, s.paid_in, s.spent, s.target_balance,
--          COALESCE(w.balance, 0) AS actual_balance
--     FROM public.sub_agent_mirror_seed s
--     LEFT JOIN public.super_agent_wallets w
--            ON w.super_agent_id = s.sub_agent_id;
-- Expect actual_balance = target_balance on every row.
--
-- NEEDS AN ADMIN - a sub-agent who spent MORE than they paid in:
--
--   SELECT s.sub_agent_id, s.paid_in, s.spent,
--          s.paid_in - s.spent AS shortfall
--     FROM public.sub_agent_mirror_seed s
--    WHERE s.paid_in - s.spent < 0;
--
-- A positive `shortfall` means their mirror was floored at 0, so the super
-- agent's real balance is carrying spend this sub-agent cannot account for.
-- Do NOT auto-resolve it: check whether those orders were paid another way,
-- and if a top-up is genuinely missing, re-run the payment rather than hand-
-- editing a balance. The view is idempotent, so re-running after a real
-- top-up converges on the right number.
--
-- THE MIRROR INVARIANT, on every super agent:
--
--   SELECT w.super_agent_id,
--          w.balance AS real_money,
--          COALESCE(sum(s.balance), 0) AS mirrored_out,
--          w.balance - COALESCE(sum(s.balance), 0) AS unencumbered
--     FROM public.super_agent_wallets w
--     JOIN public.user_profiles p ON p.super_agent_id = w.super_agent_id
--     JOIN public.super_agent_wallets s ON s.super_agent_id = p.id
--    GROUP BY w.super_agent_id, w.balance;
--
-- Expect unencumbered >= 0 everywhere. A negative value means a super agent
-- has authorised more spending than they hold, and needs a top-up.
-- ---------------------------------------------------------------------------

COMMIT;
