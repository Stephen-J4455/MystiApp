BEGIN;

-- ===========================================================================
-- Corrected wallet-funding attribution for business analytics
-- ===========================================================================
-- DEPENDS ON: 20260928_007 (wallet_topups.wallet_owner_id)
--             20260928_008 (sub-agent wallet rows + RLS on wallet_topups)
--
-- Apply 007 first. This migration is deliberately separate from 008 so that an
-- unapplied 007 cannot abort the RLS fix in 008 - a security hole must not be
-- held hostage to an optional reporting view.
--
-- THE BUG
-- -------
-- `20260924_004_create_business_analytics.sql` builds the `wallet_funding` CTE
-- with this gate:
--
--     WHERE topup.status = 'success'
--       AND EXISTS (SELECT 1 FROM super_agent_wallets w
--                    WHERE w.super_agent_id = topup.agent_id)
--
-- Read plainly: "count this top-up only if the payer is someone who holds a
-- wallet." That gate was correct while a `super_agent_wallets` row implied
-- "is a super agent" - sub-agents had no row, so their top-ups were excluded
-- from every super agent's reported funding.
--
-- Migration 20260928_008 breaks that implication: it gives every sub-agent
-- their own `super_agent_wallets` row, because a mirrored balance is what
-- makes a sub-agent's spending power visible and auditable. The moment those
-- rows exist, the EXISTS gate starts returning true for sub-agent payers, and
-- the analytics silently re-admit exactly the rows the gate was written to
-- exclude.
--
-- The damage is not cosmetic. Under the old shape, a sub-agent's money was
-- credited to the SUPER AGENT's wallet, so it belonged in that agent's funding
-- total. Once the payer is no longer the owner, `topup.agent_id` is the wrong
-- grouping key, and any report built on this column now attributes a super
-- agent's real incoming funding to the sub-agent who paid it - or drops it,
-- depending on which direction the caller was filtering.
--
-- THE FIX
-- -------
-- Attribute funding to the wallet OWNER, not the payer. A sub-agent's top-up
-- is funding for the super agent's P&L, because the money is the super
-- agent's; the payer is simply a third party who happens to be funding it.
-- `wallet_owner_id` (migration 007) records that relationship authoritatively,
-- read from `user_profiles` by the edge function.
--
-- The CASE falls back to the old self-funded test for rows written before 007
-- populated the column, so historical data keeps reporting exactly as it did
-- instead of silently dropping to NULL.
--
-- SAFE / NON-DESTRUCTIVE
-- ----------------------
-- Creates a new view. Drops nothing, updates nothing. `20260924_004`'s
-- original function is left in place deliberately: it may already be depended
-- on by a live view or a scheduled job, and this repo has no Postgres to test
-- a DROP against. Repoint the caller at `super_agent_wallet_funding` once this
-- has been applied and verified.
-- ===========================================================================

CREATE OR REPLACE VIEW public.super_agent_wallet_funding AS
SELECT
  topup.id,
  topup.created_at,
  topup.amount,
  topup.gross_amount,
  topup.charge_amount,
  topup.charge_percent,
  -- Who pressed Pay. Preserved so the super agent's tracking screen can name
  -- the sub-agent who funded a given top-up.
  topup.agent_id                        AS funder_user_id,
  -- Whose `super_agent_wallets` row the net amount was credited to.
  topup.wallet_owner_id,
  -- The correct grouping key for a super agent's funding report. NULL only for
  -- a payer with no `user_profiles` row at all, which needs an admin to
  -- resolve - never auto-assign an owner, that would credit a stranger.
  CASE
    WHEN topup.wallet_owner_id IS NOT NULL
      THEN topup.wallet_owner_id
    WHEN EXISTS (
      SELECT 1
      FROM public.super_agent_wallets AS w
      WHERE w.super_agent_id = topup.agent_id
    )
      THEN topup.agent_id
  END                                   AS effective_super_agent_id,
  -- True when a third party funded someone else's wallet. Lets a report show
  -- "Ghc 500 in, of which Ghc 200 was funded by sub-agents" without a second
  -- query, and makes the old EXISTS-gate bug detectable if it ever returns.
  (topup.wallet_owner_id IS DISTINCT FROM topup.agent_id)
                                        AS funded_by_third_party
  FROM public.wallet_topups AS topup
 WHERE topup.status = 'success';

COMMENT ON VIEW public.super_agent_wallet_funding IS
  'Successful wallet top-ups attributed to the super agent whose wallet they fund. funder_user_id is the payer; wallet_owner_id is the owner (migration 20260928_007). funded_by_third_party marks sub-agent-funded top-ups.';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- No successful top-up is left unattributed:
--
--   SELECT count(*) AS unattributed
--     FROM public.super_agent_wallet_funding
--    WHERE effective_super_agent_id IS NULL;
-- Expect 0. A non-zero count is a payer with no profile row - an admin needs
-- to set the owner before reconciliation.
--
-- The 008 regression is fixed: a sub-agent payer must NOT be the
-- effective owner, and must not be dropped from their super agent's funding.
--
--   SELECT funder_user_id, wallet_owner_id, effective_super_agent_id,
--          funded_by_third_party, sum(amount) AS total
--     FROM public.super_agent_wallet_funding
--    WHERE funded_by_third_party
--    GROUP BY 1, 2, 3, 4;
-- Every row must have effective_super_agent_id = wallet_owner_id, and
-- effective_super_agent_id <> funder_user_id.
--
-- A super agent's own funding still reads unchanged:
--
--   SELECT count(*) AS misattributed_self_funded
--     FROM public.super_agent_wallet_funding
--    WHERE NOT funded_by_third_party
--      AND effective_super_agent_id IS DISTINCT FROM funder_user_id;
-- Expect 0.
-- ---------------------------------------------------------------------------

COMMIT;
