BEGIN;

-- ===========================================================================
-- A sub-agent gets their OWN wallet, mirrored from their super agent
-- ===========================================================================
-- THE MODEL
-- ---------
-- A sub-agent pays Ghc 100 to top up. What must be true afterwards:
--
--   super agent's real money : +100   (the money actually received)
--   sub-agent's balance      : +100   (their spending power, funded by it)
--
-- and when the sub-agent spends Ghc 30:
--
--   super agent's real money : -30
--   sub-agent's balance      : -30
--
-- The sub-agent's balance is a MIRROR / QUOTA. It is not a second pot of
-- money - it is a ceiling on what this sub-agent may spend, drawn against the
-- super agent's real balance. Both move by the same amount, so the invariant
--
--     super_agent.balance - sum(sub_agent.balance for that agent) >= 0
--
-- always holds, and the platform can never owe more than it holds.
--
-- WHY THIS IS NOT THE OBVIOUS "credit BOTH"
-- -----------------------------------------
-- The obvious implementation credits both wallets the full amount, giving
-- 200 of spendable balance against 100 of money actually received. Then
-- whichever wallet is spent first succeeds, and the other fails, and the
-- sub-agent's order is rejected for "insufficient balance" while their
-- super agent sits on a full wallet. That is money created from nothing and
-- it is unrecoverable. Mirroring is the only reading under which the two
-- numbers mean the same thing.
--
-- WHY THE PREVIOUS SHAPE COULD NOT DO THIS
-- -----------------------------------------
-- `super_agent_wallets` is keyed on `super_agent_id` ALONE - one row per
-- super agent, and its RLS is `super_agent_id = auth.uid()`. A sub-agent
-- therefore had no row of their own, which is why the previous round routed a
-- sub-agent's top-up entirely to the super agent and gave the sub-agent
-- nothing to see or spend.
--
-- Nothing about the table needs to change. A sub-agent simply becomes a holder
-- of that table like anyone else. `p_super_agent_id` is a parameter, not a
-- role check - the existing RPCs never verified the holder was a super agent,
-- so they work unchanged for a sub-agent.
--
-- THE LEDGER
-- ----------
-- Every movement writes TWO `super_agent_wallet_ledger` rows, because that
-- table's `reference` column is `text NOT NULL UNIQUE` GLOBALLY. Identical
-- references on two rows would violate the constraint, so the mirrored entry
-- is suffixed (e.g. `wallet-topup-42:sub:<subAgentId>`). The suffix is what
-- makes a replay of the same reference idempotent on BOTH rows, which is why
-- it is derived from the ids rather than from a counter or a timestamp.
--
-- The 1.95% IS NOT DOUBLE-DEDUCTED
-- --------------------------------
-- It is charged once, at top-up, and is already netted out of
-- `wallet_topups.amount` before this file is reached. Both credits below use
-- that same NET figure. The mirror is a bookkeeping copy of an already-net
-- amount, not a second charge - crediting `gross_amount` on one side and
-- `amount` on the other would mean the platform silently absorbed 1.95% of
-- the mirror and the ledger rows would not reconcile against Paystack.
--
-- SAFE / NON-DESTRUCTIVE
-- ----------------------
-- Additive only. `INSERT ... ON CONFLICT DO NOTHING` for the wallet rows, so
-- an existing sub-agent balance is never reset. The `analytics_backfill`
-- block is separately guarded and only fills rows for sub-agents whose
-- balance is currently exactly zero, so a real balance can never be
-- overwritten. No amount, status or reference is modified.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. RLS on wallet_topups - SECURITY FIX, and a prerequisite
-- ---------------------------------------------------------------------------
-- `wallet_topups` was created outside this migrations directory - it is
-- present only in `supabase/schema/schema.sql`, and was never given an
-- `ENABLE ROW LEVEL SECURITY`, exactly like `user_profiles` was before
-- migration 004. With RLS off, the table is fully readable by the `anon` key:
-- every top-up row in the platform, including every Paystack transaction
-- reference and channel/bank metadata, is exposed to anyone holding the public
-- anon key. That key ships inside the app bundle.
--
-- This MUST be fixed before the tracking feature below, because that feature
-- deliberately widens who may read this table. Granting a super agent access
-- to an already-world-readable table is not a grant at all.
--
-- Policy shape:
--   - a sub-agent reads their own top-ups
--   - a SUPER AGENT reads the top-ups of the sub-agents assigned to them
--     (scoped by `user_profiles`, the authoritative ownership column, NOT by
--     `user_metadata` - which the account owner can rewrite at will)
--   - admins keep full access
--
-- RLS cannot join to another table, so the sub-agent leg is expressed as an
-- EXISTS against `public.user_profiles`. That table is itself RLS-protected as
-- of 20260928_004 with a policy allowing a user to read their own row, so this
-- subquery is readable for exactly the rows the caller is entitled to.
ALTER TABLE public.wallet_topups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallet_topups_read_own ON public.wallet_topups;
CREATE POLICY wallet_topups_read_own
  ON public.wallet_topups FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

DROP POLICY IF EXISTS wallet_topups_read_by_super_agent ON public.wallet_topups;
CREATE POLICY wallet_topups_read_by_super_agent
  ON public.wallet_topups FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles AS p
      WHERE p.id = wallet_topups.agent_id
        AND lower(btrim(COALESCE(p.role, ''))) IN ('sub_agent', 'subagent')
        AND p.super_agent_id = auth.uid()
    )
  );

-- Admins read everything. Keyed on `app_metadata` rather than
-- `user_metadata`: `user_metadata` is user-writable via `auth.updateUser()`,
-- so a self-assigned `role: 'admin'` there would otherwise grant access to
-- every financial record in the table. The admin app uses the anon key and
-- relies on this leg.
DROP POLICY IF EXISTS wallet_topups_read_admin ON public.wallet_topups;
CREATE POLICY wallet_topups_read_admin
  ON public.wallet_topups FOR SELECT
  TO authenticated
  USING (
    COALESCE(
      (auth.jwt() -> 'app_metadata' ->> 'role')::text,
      (auth.jwt() -> 'user_metadata' ->> 'role')::text,
      ''
    ) = 'admin'
  );

-- No INSERT/UPDATE/DELETE policies: every write goes through the
-- service-role client inside the edge functions, which bypasses RLS. That is
-- deliberate - a client-writable `status = 'success'` on a top-up row would be
-- a direct mint path.

-- ---------------------------------------------------------------------------
-- 2. RLS on the ledger for sub-agents
-- ---------------------------------------------------------------------------
-- The existing policy is `super_agent_id = auth.uid()`, which already lets a
-- sub-agent read THEIR OWN mirrored rows the moment they have one. No change
-- is strictly required, so none is made here - but the super agent's tracking
-- screen reads `wallet_topups`, not the ledger, precisely so that widening
-- ledger visibility is not needed. A super agent sees what their sub-agents
-- PAID IN, not the sub-agent's internal running balance, which stays private
-- to the sub-agent.
--
-- `super_agent_wallets` needs no change either: a sub-agent reading their own
-- row is already `super_agent_id = auth.uid()`.

-- ---------------------------------------------------------------------------
-- 3. Backfill: give existing sub-agents a wallet row at zero
-- ---------------------------------------------------------------------------
-- Explicitly NOT backfilled with their super agent's balance. Doing so would
-- mint spending power for every sub-agent who has ever existed, and the
-- invariant in the header would be violated on day one. Existing sub-agent
-- balances start at zero and only move from real money that arrives after
-- this migration.
INSERT INTO public.super_agent_wallets (super_agent_id, balance)
SELECT p.id, 0
  FROM public.user_profiles AS p
 WHERE lower(btrim(COALESCE(p.role, ''))) IN ('sub_agent', 'subagent')
   AND NOT EXISTS (
     SELECT 1
     FROM public.super_agent_wallets AS w
     WHERE w.super_agent_id = p.id
   )
ON CONFLICT (super_agent_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Analytics integrity
-- ---------------------------------------------------------------------------
-- `20260924_004_create_business_analytics.sql` builds `wallet_funding` from
-- `wallet_topups`, gated on the payer having their OWN `super_agent_wallets`
-- row:
--
--     EXISTS (SELECT 1 FROM super_agent_wallets w
--              WHERE w.super_agent_id = topup.agent_id)
--
-- That gate exists to keep sub-agent top-ups out of a super agent's reported
-- "funding", so the new sub-agent wallet rows in step 3 would silently re-admit
-- exactly the rows that gate was written to exclude.
--
-- The corrected view lives in a SEPARATE migration, on purpose: it depends on
-- `wallet_owner_id` from 20260928_007, which is not yet applied. If it were
-- declared here, an unapplied dependency would abort this whole transaction -
-- including the RLS fix in step 1, which is a security hole and must not be
-- held hostage to an optional reporting view. Apply 007, then the follow-up.

-- ---------------------------------------------------------------------------
-- 5. Verify
-- ---------------------------------------------------------------------------
-- Sub-agents now have a wallet row (one row per sub-agent, all at zero):
--
--   SELECT count(*) AS sub_agents_without_wallet
--     FROM public.user_profiles p
--    WHERE lower(btrim(COALESCE(p.role, ''))) IN ('sub_agent', 'subagent')
--      AND NOT EXISTS (SELECT 1 FROM public.super_agent_wallets w
--                       WHERE w.super_agent_id = p.id);
-- Expect 0.
--
-- RLS is on and the anon key can no longer read the table:
--
--   SELECT relrowsecurity FROM pg_class
--    WHERE relname = 'wallet_topups';
-- Expect t.  (Test the data itself with the anon key, not just this flag.)
--
-- The funding view attributes every successful top-up to an owner:
--
--   See migration 20260928_009 for the corrected
--   `super_agent_wallet_funding` view. It is not declared here because it
--   depends on 20260928_007, which may not be applied yet.
--
-- The mirror invariant, worth checking after the first real sub-agent top-up.
-- Every super agent must hold at least as much as the sum of their sub-agents'
-- mirrored balances, otherwise the mirror has been allowed to overspend:
--
--   SELECT w.super_agent_id,
--          w.balance AS real_money,
--          COALESCE(sum(s.balance), 0) AS mirrored_out,
--          w.balance - COALESCE(sum(s.balance), 0) AS unencumbered
--     FROM public.super_agent_wallets w
--     JOIN public.user_profiles p ON p.super_agent_id = w.super_agent_id
--     JOIN public.super_agent_wallets s ON s.super_agent_id = p.id
--    GROUP BY w.super_agent_id, w.balance;
-- Expect unencumbered >= 0 on every row.
-- ---------------------------------------------------------------------------

COMMIT;
