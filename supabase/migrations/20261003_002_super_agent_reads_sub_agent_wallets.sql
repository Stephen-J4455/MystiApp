BEGIN;

-- ===========================================================================
-- Super Agents read their Sub-Agents' wallet balances, ledger and orders
-- ===========================================================================
-- APPLY AFTER: 20260928_008 (sub_agent_wallet_mirror)
--
-- THE GAP
-- -------
-- A Super Agent's Transactions screen shows three things: their own top-ups,
-- their own payment ledger, and their sub-agents' HELD orders. Everything else
-- about their sub-agents was invisible to them, for two independent reasons:
--
--   1. `super_agent_wallets` and `super_agent_wallet_ledger` are both scoped
--      `super_agent_id = auth.uid()`. A sub-agent's row is keyed on the
--      SUB-AGENT's id, so a super agent reading their own id matched nothing
--      and got an empty list rather than an error - the screen simply looked
--      like they had no sub-agent activity.
--
--   2. Migration 20260928_008 §2 made this a DELIBERATE decision, on the
--      grounds that "a super agent sees what their sub-agents PAID IN, not the
--      sub-agent's internal running balance, which stays private to the
--      sub-agent". That reasoning was sound for `wallet_topups` and wrong for
--      the running balance: the mirror exists precisely to cap what a sub-agent
--      may spend out of the super agent's real money, so the super agent is
--      the party with the strongest legitimate need to see it. A sub-agent who
--      can spend has no ceiling the super agent cannot check, and every
--      shortfall they hit surfaces to the super agent as a failed purchase they
--      must fund.
--
-- This widens it to the roster, which is the relationship the platform
-- actually models. A super agent can now see the full picture of the money
-- they are on the hook for.
--
-- ===========================================================================
-- WHY `user_profiles` AND NOT `super_agent_id = auth.uid()`
-- ===========================================================================
-- RLS cannot join, so the sub-agent leg is an EXISTS against
-- `public.user_profiles`, exactly mirroring `wallet_topups_read_by_super_agent`
-- from 20260928_008. That table carries the authoritative, admin-written
-- `super_agent_id` - the client cannot set it on themselves, which is the whole
-- reason `verify-payment` reads ownership from there rather than from
-- `user_metadata` (user-writable via `auth.updateUser()`).
--
-- Using `p.super_agent_id = auth.uid()` instead would match only the super
-- agent's OWN row, which is what the existing policy already does and is
-- precisely the bug.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. super_agent_wallets - the running balances
-- ---------------------------------------------------------------------------
-- Read-only. Balances move exclusively through the SECURITY DEFINER RPCs
-- (`credit_super_agent_wallet` / `debit_super_agent_wallet`) and the admin
-- top-up/debit functions, all of which use the service role. No INSERT /
-- UPDATE / DELETE policy is added, so a super agent can never mint a balance
-- for anyone - including themselves, which is what the mirror is defending
-- against.
ALTER TABLE public.super_agent_wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS super_agent_wallets_read_by_super_agent
  ON public.super_agent_wallets;
CREATE POLICY super_agent_wallets_read_by_super_agent
  ON public.super_agent_wallets FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.user_profiles AS p
       WHERE p.id = super_agent_wallets.super_agent_id
         AND lower(btrim(COALESCE(p.role, ''))) IN ('sub_agent', 'subagent')
         AND p.super_agent_id = (SELECT auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 2. super_agent_wallet_ledger - the wallet actions / movements
-- ---------------------------------------------------------------------------
-- Every credit and debit a sub-agent's mirrored wallet made. This is the
-- "wallet processes" the super agent needs: it is the only record of HOW a
-- balance got to its current value, and the only way to tell a sub-agent who
-- simply has not sold anything from one whose orders are quietly failing.
--
-- It exposes entry_type, amount, balance_before/after, reason and metadata for
-- the sub-agent's rows only. The existing `super_agent_id = auth.uid()` policy
-- is untouched, so both legs coexist as an OR - a super agent sees their own
-- rows and their sub-agents', and nothing else.
ALTER TABLE public.super_agent_wallet_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS super_agent_wallet_ledger_read_by_super_agent
  ON public.super_agent_wallet_ledger;
CREATE POLICY super_agent_wallet_ledger_read_by_super_agent
  ON public.super_agent_wallet_ledger FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.user_profiles AS p
       WHERE p.id = super_agent_wallet_ledger.super_agent_id
         AND lower(btrim(COALESCE(p.role, ''))) IN ('sub_agent', 'subagent')
         AND p.super_agent_id = (SELECT auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 3. agent_orders - a Super Agent's sub-agents' orders, any status
-- ---------------------------------------------------------------------------
-- The client already queries `agent_orders` filtered by
-- `super_agent_id = auth.uid()` (History, Home, SuperAgentHeldOrders, and
-- SuperAgentTransactions). `agent_orders` has never had RLS ENABLED, so those
-- reads only worked because RLS being OFF means "read everything" - which is
-- why this was missed: the queries were not wrong, the table was simply
-- unprotected.
--
-- Enabling RLS here is a genuine tightening, and it is necessary: leaving it
-- off while widening the wallet tables would be inconsistent, and it would
-- leave every user's sub-agent orders readable by every other authenticated
-- account. The policy set below is deliberately scoped to reproduce the access
-- the app already depends on, and no more.
--
-- NOTE ON THE PREVIOUS STATE: because RLS was off, any authenticated account
-- could already select ANY agent order via the anon key. Enabling this closes
-- that. It is a security fix, not a regression - no legitimate screen depended
-- on reading somebody else's rows.
ALTER TABLE public.agent_orders ENABLE ROW LEVEL SECURITY;

-- Admins read every order. Keyed on `app_metadata` ONLY: `user_metadata` is
-- writable via `auth.updateUser()`, so a self-assigned `role: 'admin'` there
-- would grant access to every order in the platform. The admin app uses the
-- anon key and relies on this leg.
DROP POLICY IF EXISTS agent_orders_read_admin ON public.agent_orders;
CREATE POLICY agent_orders_read_admin
  ON public.agent_orders FOR SELECT
  TO authenticated
  USING (
    lower(btrim(COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '')))
    IN ('admin', 'administrator', 'superadmin', 'super_admin')
  );

-- The sub-agent reads their own orders.
DROP POLICY IF EXISTS agent_orders_read_own ON public.agent_orders;
CREATE POLICY agent_orders_read_own
  ON public.agent_orders FOR SELECT
  TO authenticated
  USING (agent_id = (SELECT auth.uid()));

-- The super agent reads orders placed by their sub-agents - the actual fix
-- for "sub agent orders do not show in their super agent account". Without
-- this leg a super agent could not see the orders they are settling for.
DROP POLICY IF EXISTS agent_orders_read_by_super_agent
  ON public.agent_orders;
CREATE POLICY agent_orders_read_by_super_agent
  ON public.agent_orders FOR SELECT
  TO authenticated
  USING (super_agent_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. payment_transactions - the payment records for those orders
-- ---------------------------------------------------------------------------
-- `payment_transactions_super_agent_read` from 20260921_002 already covers
-- `super_agent_id = auth.uid()`, and `verify-payment` stamps `super_agent_id`
-- on every Sub-Agent order, so a super agent can ALREADY read their sub-agents'
-- payment records. No new policy is needed and none is added.
--
-- Recorded here because it is the one leg of this feature that already worked,
-- and it is why the symptom looked like "orders are missing" rather than
-- "everything about my sub-agents is hidden": the ledger arrived, the orders
-- did not.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Every table this touches must have RLS ON:
--
--   SELECT c.relname, c.relrowsecurity
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname IN ('agent_orders', 'super_agent_wallets',
--                         'super_agent_wallet_ledger')
--    ORDER BY c.relname;
--   -- expect relrowsecurity = true for all three
--
-- And the policy set on agent_orders:
--
--   SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'agent_orders'
--    ORDER BY policyname;
--   -- expect: agent_orders_read_admin, agent_orders_read_by_super_agent,
--   --         agent_orders_read_own
--
-- REGRESSION CHECK - run as a real sub-agent and a real super agent, because
-- RLS is not testable with the service role, which bypasses it. As a sub-agent
-- you should still see your own orders and nothing else; as a super agent your
-- own plus your sub-agents'. If a sub-agent suddenly sees zero rows, the
-- `agent_orders_read_own` policy is missing - the table previously had NO RLS
-- at all, so an agent_orders read that used to work can only have been working
-- through a policy added here.

COMMIT;
