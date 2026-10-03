BEGIN;

-- ===========================================================================
-- A Super Agent reads their own Sub-Agents' profile rows
-- ===========================================================================
-- APPLY AFTER: 20260928_004 (user_profiles_realtime_rls)
--              20261003_002 (super_agent_reads_sub_agent_wallets)
--
-- THE GAP
-- -------
-- 20261003_002 widened `agent_orders`, `super_agent_wallets`,
-- `super_agent_wallet_ledger` and (via 20260928_008) `wallet_topups` to the
-- roster, so a super agent can now read their sub-agents' orders, balances,
-- wallet movements and top-ups. Every one of those rows is keyed on a raw
-- SUB-AGENT uuid.
--
-- But `user_profiles` - the only table that maps that uuid to a human name -
-- has never been readable beyond the caller's OWN row:
--
--     user_profiles_select_own   USING (id = auth.uid())
--     user_profiles_select_admin USING (app_metadata role is admin)
--
-- Neither leg matches a sub-agent's row, so `fetchSubAgentBalances` in
-- `src/lib/superAgentRoster.js` - which selects
-- `user_profiles ... WHERE super_agent_id = <caller>` - gets RLS-filtered to an
-- EMPTY list rather than an error.
--
-- That is the silent-zero trap the rest of this schema is written against: an
-- HTTP 200 with zero rows, indistinguishable from "this super agent genuinely
-- has no sub-agents". It is why the Transactions screen's mirrored-balance
-- strip renders empty for a super agent who demonstrably has a roster, and why
-- every roster order they can see is attributed to an anonymous "Sub-agent".
--
-- WHAT THIS ADDS
-- --------------
-- One read-only leg: a super agent may read the profile rows of the accounts
-- they own. Nothing else changes.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT A PRIVILEGE WIDENING
-- ---------------------------------------------------------------------------
-- `user_profiles.super_agent_id` is written ONLY by admins (the User Management
-- edge function runs on the service role). It is not reachable from the client:
-- the app never writes this column, and a sub-agent cannot repoint themselves
-- onto another agent's roster. The roster relationship is therefore exactly the
-- one the business already models, and reading it is the minimum a super agent
-- needs to make sense of the activity 20261003_002 just made visible.
--
-- The blast radius is deliberately small. It exposes `full_name`,
-- `business_name`, `email`, `phone`, `role` and `super_agent_id` for accounts
-- the caller already has a financial relationship with - the same records the
-- Transactions screen already renders for those same people, and the same
-- records `super-agent-user-management` returns to the roster's owner.
--
-- It grants nothing else: no INSERT/UPDATE/DELETE leg is added, so a super
-- agent still cannot promote themselves, cannot rewrite their own role, and
-- cannot edit a sub-agent. Role changes remain admin-only, exactly as
-- `verify-payment`'s `resolveIdentity` requires.
--
-- ---------------------------------------------------------------------------
-- WHY A SECURITY DEFINER HELPER, NOT AN EXISTS SUBQUERY
-- ---------------------------------------------------------------------------
-- The obvious policy body is:
--
--     USING (EXISTS (SELECT 1 FROM public.user_profiles p
--                     WHERE p.id = auth.uid()
--                       AND p.super_agent_id = user_profiles.super_agent_id))
--
-- It is WRONG, and it fails at CREATE time with
-- "infinite recursion detected in policy for relation user_profiles".
--
-- RLS on a table applies to EVERY read of that table, INCLUDING the subquery
-- inside the policy that is doing the reading. So the predicate re-enters its
-- own policy, which re-enters the subquery, forever; Postgres detects the
-- cycle and refuses the statement. It does not silently over-permit - it hard
-- fails - and `fetchSubAgentBalances` goes on returning `[]`.
--
-- (Note the second trap in the same expression: `super_agent_id =
-- auth.uid()` ON THE ROW ITSELF, which is the shorter form people reach for
-- first, requires self-referential ownership and matches nobody. The roster
-- has to be identified from the CALLER's own profile row.)
--
-- The established escape in this schema is `is_mysti_admin()` (20260926_010):
-- a SECURITY DEFINER function owns the table as its migration owner, and the
-- definer's rights bypass the caller's RLS on the rows it reads. The same
-- technique backs `credit_super_agent_wallet` / `debit_super_agent_wallet`
-- and `is_held_order_expired`. It is followed here for the same reason, with
-- the same hardening.
--
-- The helper reads ONE column off ONE row - the caller's own
-- `super_agent_id` - which is the narrowest thing a definer function can be
-- asked to expose, and it RETURNS A BOOLEAN rather than a row, so it cannot be
-- repurposed as an oracle to read any profile field.
--
-- ---------------------------------------------------------------------------
-- WHY THE CALLER'S ROLE IS CHECKED HERE
-- ---------------------------------------------------------------------------
-- The role test on `me` is not redundant, and omitting it is a real disclosure
-- bug rather than a theoretical one.
--
-- A SUB-AGENT's own profile row also carries a `super_agent_id` - it points at
-- the agent they report to. So a helper that keys on `me.super_agent_id` alone
-- lets a sub-agent ask `is_my_super_agent(<sibling>)` and get TRUE for every
-- other sub-agent under the same agent: their own row says "my agent is X",
-- and the sibling's row says "my agent is X", so they match. That would hand
-- every sub-agent a roster of their colleagues' names, business names, emails
-- and phone numbers.
--
-- Requiring `me.role` to be a super agent is what makes the leg mean what its
-- name says. `user_profiles.role` is the AUTHORITATIVE store - the same column
-- every edge function's `resolveIdentity` authorizes from - so this is not a
-- second, weaker source of truth. It is not user-writable: `user_metadata` is,
-- and nothing here reads it.
--
-- The accepted spellings match the rest of this schema
-- (`afa_settings_super_agent_read` in 20260926_010), so a row cannot be denied
-- or admitted purely on how its role happens to be capitalised.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The helper
-- ---------------------------------------------------------------------------
-- CORRECTNESS OF THE JOIN, AND THE TRAP IN IT
-- --------------------------------------------
-- The obvious way to express "is target_id on my roster" is to match the two
-- rows on a shared `super_agent_id`:
--
--     them.super_agent_id = me.super_agent_id
--
-- That is WRONG, and it fails SILENTLY - no error, zero rows, which in the app
-- is indistinguishable from having no sub-agents at all.
--
-- A super agent is the TOP of the hierarchy. Their own `super_agent_id` is
-- NULL, because nobody is above them. A sub-agent's `super_agent_id` is the
-- super agent's `id`, not the super agent's own id. So the shared-value
-- comparison never holds for the one caller this policy exists to serve, and
-- the correct predicate is the directed one:
--
--     them.super_agent_id = (SELECT auth.uid())
--
-- matching `wallet_topups_read_by_super_agent` (20260928_008) and the
-- policies added in 20261003_002, all of which key on
-- `p.super_agent_id = (SELECT auth.uid())`.
--
-- The `me` row is still read - to establish that the CALLER is a super agent -
-- but only for its `role`. Reading its `super_agent_id` here is what an earlier
-- draft of this file did, via `me.super_agent_id IS NOT NULL`, and that clause
-- is precisely what made the helper return false for everyone.
CREATE OR REPLACE FUNCTION public.is_my_super_agent(target_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  -- Role matching mirrors `normalizeRole` in the edge functions. The policies
  -- elsewhere in this schema test a hand-picked pair (IN ('sub_agent',
  -- 'subagent')), which silently DENIES a row spelled 'sub-agent' - and a
  -- denied row is a missing name on a statement, never an error. Listing the
  -- hyphenated and spaced spellings explicitly is equivalent to
  -- `replace(..., '-', '_')` here while staying readable in a policy body.
  WITH normalized AS (
    SELECT
      id,
      lower(btrim(COALESCE(role, ''))) AS role,
      super_agent_id
      FROM public.user_profiles
  )
  SELECT EXISTS (
    SELECT 1
      FROM normalized AS them
     WHERE them.id = target_id
       AND them.super_agent_id = (SELECT auth.uid())
       AND them.role IN ('sub_agent', 'subagent', 'sub-agent', 'sub agent')
       AND EXISTS (
         SELECT 1
           FROM normalized AS me
          WHERE me.id = (SELECT auth.uid())
            AND me.role IN ('super_agent', 'superagent', 'super-agent', 'super agent')
       )
  );
$$;

COMMENT ON FUNCTION public.is_my_super_agent(uuid) IS
  'True when target_id is a Sub-Agent on the calling user''s roster. SECURITY DEFINER because a policy on user_profiles cannot join user_profiles in its own body - that recurses. Returns a boolean, never a row.';

REVOKE ALL ON FUNCTION public.is_my_super_agent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_my_super_agent(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. The policy
-- ---------------------------------------------------------------------------
-- Already enabled by 20260928_004; restated only so a partial apply is
-- obvious. A no-op when it is already on.
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- `id = auth.uid()` is deliberately NOT restated. Permissive policies are
-- OR-ed together, so this one only has to carry the NEW leg - the own-row leg
-- keeps working from 20260928_004. Repeating it would be harmless, but it would
-- give the verification query below four policies to reconcile instead of three.
DROP POLICY IF EXISTS user_profiles_select_by_super_agent
  ON public.user_profiles;
CREATE POLICY user_profiles_select_by_super_agent
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (public.is_my_super_agent(id));

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- RLS must be ON (it already was, from 20260928_004 - restated so a partial
-- apply is obvious):
--
--   SELECT relrowsecurity FROM pg_class
--    WHERE oid = 'public.user_profiles'::regclass;
--   -- expect t
--
--   SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'user_profiles'
--    ORDER BY policyname;
--   -- expect: user_profiles_select_admin, user_profiles_select_by_super_agent,
--   --         user_profiles_select_own
--
-- And the helper is not exposed to anon:
--
--   SELECT has_function_privilege('anon', 'public.is_my_super_agent(uuid)', 'EXECUTE');
--   -- expect f
--
-- REGRESSION CHECK - run as a real sub-agent and a real super agent, because
-- RLS is not testable with the service role, which bypasses it:
--
--   As a sub agent:
--     SELECT count(*) FROM public.user_profiles;
--   -- expect exactly 1 (your own row). A larger number means this policy is
--   -- over-broad.
--
--   As a sub agent, the SIBLING case specifically - this is the one that the
--   role check exists to prevent, and it is not obvious from the roster alone:
--     SELECT count(*) FROM public.user_profiles
--      WHERE super_agent_id = (SELECT super_agent_id FROM public.user_profiles
--                               WHERE id = (SELECT auth.uid()));
--   -- expect 0. If this returns the size of your agent's roster, the role
--   -- clause is missing from the helper.
--
--   As a super agent:
--     SELECT count(*) FROM public.user_profiles
--      WHERE super_agent_id = (SELECT auth.uid());
--   -- expect the full roster, matching what the admin app shows you. Zero
--   -- means the policy did not land - it fails closed, it does not error, so
--   -- an empty roster is indistinguishable in the app from having no
--   -- sub-agents.
--
-- THE TOP-OF-HIERARCHY CHECK - the one that catches the bug this file
-- previously had. A super agent's own `super_agent_id` is NULL, because
-- nobody is above them, so a helper that compares the caller's
-- `super_agent_id` against the target's returns FALSE for every row and the
-- roster reads as empty with no error anywhere. Run this as a super agent:
--
--     SELECT super_agent_id IS NULL AS agent_is_top_of_tree
--       FROM public.user_profiles WHERE id = (SELECT auth.uid());
--   -- expect t. If this is f, the caller is not actually a super agent and
--   -- the policy is correctly refusing - fix the ROLE, not the helper.
--
--     SELECT public.is_my_super_agent(<a real sub-agent's uuid>);  -- expect t
--
--   As a normal user:
--     SELECT count(*) FROM public.user_profiles;
--   -- expect exactly 1.
--
-- Two unassigned accounts are not a roster, so a NULL on either side must not
-- match:
--
--   SELECT public.is_my_super_agent(NULL);   -- expect f
--
-- Cross-roster check - MUST be zero:
--
--   SELECT count(*) FROM public.user_profiles
--    WHERE id <> (SELECT auth.uid())
--      AND super_agent_id IS DISTINCT FROM (SELECT auth.uid())
--      AND public.is_my_super_agent(id);
--   -- expect 0

COMMIT;
