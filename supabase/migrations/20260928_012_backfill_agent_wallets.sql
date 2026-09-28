BEGIN;

-- ===========================================================================
-- Backfill wallet rows for promoted sub-agents and super agents
-- ===========================================================================
-- DEPENDS ON: 20260928_008 (sub-agent wallet rows), 20260928_011 (seeding)
-- APPLY AFTER: 007, 008, 010, 009, 011
--
-- WHY
-- ---
-- `admin-users.setUserRole` never created a `super_agent_wallets` row when it
-- promoted an account. The only way a row came into existence was
-- `initializeSuperAgentWallet`, a manual per-user action behind an admin
-- button. So promoting a user left them with NO wallet at all, which the admin
-- app renders as "Not initialized" - a badge that reads as though the account
-- is held or pending, when the truth is that the row simply does not exist yet.
--
-- `verify-payment` no longer treats this as a blocker: a sub-agent's wallet
-- path resolves the owner and creates rows on first use via the credit/debit
-- RPCs' `INSERT ... ON CONFLICT DO NOTHING`. But the main app's
-- `App.js` ownership probe and the admin's wallet panel both read for an
-- existing row, so a missing one reads as "no wallet" rather than "not yet
-- opened".
--
-- The function now seeds the row at promotion time. This migration repairs
-- every account that was promoted BEFORE that change.
--
-- WHICH ACCOUNTS
-- --------------
-- Every sub-agent and super agent without a row. NOT normal users: they have
-- no legitimate wallet, and the client gate now refuses to show one. Creating
-- rows for them would be inventing an account type that cannot spend.
--
-- BALANCE
-- -------
-- 0 for a super agent, which is correct: a super agent's balance only ever
-- comes from a real top-up, and inventing one would be fabricating money.
--
-- A SUB-AGENT is different. They now hold a mirrored balance, and
-- `sub_agent_mirror_seed` (migration 011) already computes it from their own
-- paid-in history. This migration therefore reads that view rather than
-- hardcoding 0, so an account promoted after 011 ran still gets a correctly
-- seeded mirror instead of a zero balance an admin then has to notice and
-- re-seed by hand.
--
-- A sub-agent with no history seeds to 0 either way - the view floors at 0 and
-- `paid_in - spent` is 0 when neither happened.
--
-- `ON CONFLICT DO NOTHING` is the safety story: a super agent with real money,
-- or a sub-agent already seeded by 011, is left completely untouched. This
-- migration can only ever ADD missing rows.
--
-- SAFE / NON-DESTRUCTIVE
-- ----------------------
-- Insert-only. No UPDATE, no DELETE. `super_agent_wallets.balance` defaults to
-- 0 and the CHECK (balance >= 0) holds. Re-running is a no-op.
-- ===========================================================================

INSERT INTO public.super_agent_wallets (super_agent_id, balance)
SELECT p.id,
       -- The computed mirror for a sub-agent, 0 for a super agent or a
       -- sub-agent with no history. COALESCE covers the super-agent case: they
       -- are not in the seed view at all, which is correct, so they start empty.
       COALESCE(
         (SELECT s.target_balance
            FROM public.sub_agent_mirror_seed AS s
           WHERE s.sub_agent_id = p.id),
         0
       )
  FROM public.user_profiles AS p
 WHERE lower(btrim(COALESCE(p.role, ''))) IN ('sub_agent', 'super_agent')
   AND NOT EXISTS (
     SELECT 1
       FROM public.super_agent_wallets AS w
      WHERE w.super_agent_id = p.id
   )
ON CONFLICT (super_agent_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Every sub-agent and super agent now has a row. Expect 0.
--
--   SELECT count(*) AS agents_without_wallet
--     FROM public.user_profiles AS p
--    WHERE lower(btrim(COALESCE(p.role, ''))) IN ('sub_agent', 'super_agent')
--      AND NOT EXISTS (SELECT 1 FROM public.super_agent_wallets AS w
--                       WHERE w.super_agent_id = p.id);
--
-- No normal user gained a wallet - expect 0. A non-zero count means one was
-- created by an earlier manual action and should be reviewed.
--
--   SELECT count(*) AS normal_users_with_wallet
--     FROM public.user_profiles AS p
--     JOIN public.super_agent_wallets AS w ON w.super_agent_id = p.id
--    WHERE lower(btrim(COALESCE(p.role, ''))) IN ('user', 'normal_user',
--                                                 'normaluser');
--
-- Any it finds are NOT deleted here. Deleting a row destroys a balance and a
-- history, and the safe move is to look at each one rather than bulk-remove.
-- The client already refuses to display a wallet for these accounts, so they
-- are inert.
--
-- The seeded sub-agent balances from 011 survived this migration:
--
--   SELECT s.sub_agent_id, s.target_balance, w.balance
--     FROM public.sub_agent_mirror_seed AS s
--     JOIN public.super_agent_wallets AS w
--       ON w.super_agent_id = s.sub_agent_id
--    WHERE s.target_balance <> w.balance;
-- Expect 0 rows. A non-zero count means 011 ran BEFORE the new accounts were
-- created, which is fine - re-run 011, it is idempotent and recomputes from
-- full history.
-- ---------------------------------------------------------------------------

COMMIT;
