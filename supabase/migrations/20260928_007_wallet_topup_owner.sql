BEGIN;

-- ===========================================================================
-- A sub-agent's wallet top-up funds their SUPER AGENT
-- ===========================================================================
-- WHY
-- ---
-- `verify-wallet-topup` credits the wallet with `p_super_agent_id => user.id`
-- and settles the Paystack payment to the payer. That is only correct for a
-- Super Agent funding their OWN wallet.
--
-- A SUB-AGENT has no `super_agent_wallets` row of their own - `verify-payment`
-- spends the wallet by `p_super_agent_id => user.id`, so a personal row would
-- be unspendable. Their money is meant to fund the super agent they report to,
-- whose wallet is what actually buys data on their behalf.
-- The old code had a latent half of this: it computed
--
--     let resolvedSuperAgentId = identity.superAgentId ?? user.id;
--
-- and then IGNORED it for the credit, hardcoding `user.id`. So a sub-agent's
-- top-up was routed to their super agent's SUB-ACCOUNT for settlement but
-- credited to a wallet row keyed on the sub-agent's own id - a row nothing can
-- spend. Reconciling a Paystack settlement against a wallet that no order ever
-- debits is how money goes missing at month end.
--
-- `verify-payment` had the matching half of the same bug: its wallet path
-- pre-flight balance check and its `debit_super_agent_wallet` call both used
-- the caller's own id too. Both are resolved from the same precedence here, so
-- money can only be spent from the wallet it was funded into.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Records the real relationship on the top-up row so the credit, the
-- settlement code and the analytics all agree on who funded what:
--
--   funder_user_id  - who pressed Pay (the sub-agent, or the super agent)
--   wallet_owner_id - whose `super_agent_wallets` row the NET is credited to
--
-- For a Super Agent both are the same value, so existing rows stay meaningful.
--
-- BACKFILL
-- ---------
-- `wallet_topups.agent_id` was written as the PAYER, so for a genuine sub-agent
-- row the payer is not the wallet owner. The owner is recovered from
-- `user_profiles.super_agent_id` - the AUTHORITATIVE ownership column, and the
-- one `verify-payment` itself reads. Accounts with no profile row, or with no
-- owner, are left as-is rather than guessed at: a wrong owner would credit the
-- wrong wallet, which is worse than an obviously-unmapped row.
--
-- SAFE / NON-DESTRUCTIVE
-- ----------------------
-- Additive columns only. No rows are updated except the backfill, which only
-- fills two new columns and never changes an amount, a status or a reference.
-- Re-running is a no-op once populated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The relationship columns
-- ---------------------------------------------------------------------------
-- Nullable: a pre-existing deployment, or a top-up written by a client that
-- predates this, must still insert successfully. The edge function treats NULL
-- as "fall back to the payer".
ALTER TABLE public.wallet_topups
  ADD COLUMN IF NOT EXISTS funder_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wallet_owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.wallet_topups.funder_user_id IS
  'Who paid: the sub-agent, or the super agent funding their own wallet. Equal to agent_id for a super agent.';
COMMENT ON COLUMN public.wallet_topups.wallet_owner_id IS
  'Whose super_agent_wallets row the net amount is credited to. Equals the super agent for a sub-agent top-up; equals funder_user_id for a super agent top-up.';

-- The analytics and settlement views group by the wallet owner, so this is the
-- column they must be able to filter and sort on.
CREATE INDEX IF NOT EXISTS idx_wallet_topups_wallet_owner
  ON public.wallet_topups (wallet_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_funder
  ON public.wallet_topups (funder_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Backfill
-- ---------------------------------------------------------------------------
-- `agent_id` is the payer. Where that payer is a sub-agent, the owner is their
-- super agent. Where the payer is a super agent, the owner is themselves.
--
-- The `role` check uses the same normalisation as every edge function's
-- `normalizeRole`, so a row cannot be mapped to the wrong owner merely because
-- the role is spelled differently.
--
-- Scoped to rows whose new columns are still empty, so re-running is a no-op
-- and a deliberate later correction is never stomped.
UPDATE public.wallet_topups AS t
   SET funder_user_id = t.agent_id,
       wallet_owner_id = CASE
         WHEN lower(btrim(COALESCE(p.role, ''))) = 'super_agent' THEN t.agent_id
         ELSE p.super_agent_id
       END
  FROM public.user_profiles AS p
 WHERE p.id = t.agent_id
   AND (t.funder_user_id IS NULL OR t.wallet_owner_id IS NULL);

-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------
-- Every settled top-up is now attributable to a wallet owner:
--
--   SELECT count(*) AS unattributed
--     FROM public.wallet_topups
--    WHERE status = 'success'
--      AND wallet_owner_id IS NULL;
--
-- A non-zero count means a payer with no `user_profiles` row, or a sub-agent
-- with no super agent assigned. Those need an admin to set their owner before
-- a refund can be reconciled - do NOT auto-assign them.
--
-- Spot-check that sub-agent top-ups point at their super agent:
--
--   SELECT t.reference, t.agent_id, t.wallet_owner_id, p.super_agent_id
--     FROM public.wallet_topups t
--     JOIN public.user_profiles p ON p.id = t.agent_id
--    WHERE lower(p.role) = 'sub_agent'
--      AND t.wallet_owner_id IS DISTINCT FROM p.super_agent_id;
--
-- Expect ZERO rows. Any row here is a mapping error worth investigating.
--
-- Super-agent self-funding is unchanged:
--
--   SELECT count(*) FROM public.wallet_topups t
--     JOIN public.user_profiles p ON p.id = t.agent_id
--    WHERE lower(p.role) = 'super_agent'
--      AND t.wallet_owner_id IS DISTINCT FROM t.agent_id;
-- ---------------------------------------------------------------------------

COMMIT;
