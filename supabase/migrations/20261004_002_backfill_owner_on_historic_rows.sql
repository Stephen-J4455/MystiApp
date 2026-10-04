BEGIN;

-- ===========================================================================
-- Back-fill the owner on orders and payment rows written while a sub-agent had
-- no Super Agent assignment
-- ===========================================================================
-- APPLY AFTER: 20261004_001 (repair_ownerless_sub_agents)
--
-- WHY 001 IS NOT ENOUGH
-- ---------------------
-- 001 repairs `user_profiles.super_agent_id`. That fixes the ROSTER and
-- unblocks FUTURE orders. It cannot reach rows already written, because the
-- missing owner was snapshotted onto each row at write time.
--
-- THE DEFECT, PRECISELY
-- --------------------
-- `verify-payment` derives ownership once, near the top:
--
--     const resolvedSuperAgentId = identity.superAgentId;
--     const isSubAgentOrder    = Boolean(resolvedSuperAgentId);
--     const isAgentOrder       = Boolean(
--       resolvedSuperAgentId || identity.role === 'sub_agent',
--     );
--
-- An ownerless sub agent satisfies the SECOND term of `isAgentOrder` on ROLE
-- alone. So their order was still written to `agent_orders` - the correct
-- table, with `buyer_type: 'sub_agent'` - but stamped with
-- `super_agent_id: resolvedSuperAgentId`, which was NULL.
--
-- So these rows sit on the RIGHT table carrying an ABSENT owner:
--
--     agent_orders.super_agent_id          -> NULL
--     payment_transactions.super_agent_id  -> NULL
--
-- The same applies to the wallet DEBIT, which is guarded on `isSubAgentOrder`
-- rather than `isAgentOrder`:
--
--     if (isSubAgentOrder) { debit_super_agent_wallet(p_super_agent_id =>
--     resolvedSuperAgentId, ...) }
--
-- `isSubAgentOrder` is false with no owner, so NO debit was attempted and NO
-- wallet was charged. The order was created and dispatched, and the sub agent's
-- super agent's wallet was never debited for it.
--
-- ---------------------------------------------------------------------------
-- WHY IT IS INVISIBLE
-- ------------------
-- Every read of this data filters on the missing column:
--
--     fetchSubAgentOrders    agent_orders          WHERE super_agent_id = <caller>
--     fetchSubAgentPayments  payment_transactions  WHERE super_agent_id = <caller>
--
-- NULL equals nothing, so the predicate is NULL, the row is filtered out and the
-- query returns an empty list. It never errors - these reads are HTTP 200 with
-- zero rows, the silent-zero trap this schema is written against.
--
-- Hence "my sub agent's orders are not loading" on BOTH the Transactions screen
-- and Home's recent activity, with nothing to diagnose it: both surfaces read
-- these same two columns.
--
-- 001 ALONE MAKES IT STRICTLY WORSE, which is worth stating plainly. After 001
-- the sub agent HAS an owner in `user_profiles`, so `verify-payment` stamps new
-- orders correctly while the historic NULLs stay invisible. The split then
-- looks like a filter that only works for recent purchases.
-- ---------------------------------------------------------------------------
-- HOW AN OWNER IS RECOVERED, AND WHY IT IS SAFE
-- --------------------------------------------
-- The owner is recovered from the account's `user_metadata.super_agent_id` -
-- the one field `createSubAgent` did write, and the only surviving record of
-- who created this person.
--
-- It is self-writable via `auth.updateUser({ data: { super_agent_id } })`, so
-- on its own it is NOT trustworthy. THREE independent conditions must all hold
-- before any row is touched:
--
--   1. CROSS-CHECK. The account's `user_profiles.super_agent_id` - repaired by
--      001, admin-written, never self-written - must ALREADY equal the claimed
--      owner. Two independent stores agreeing is what separates a recovery from
--      a guess. Any disagreement, or a NULL on either side, leaves the row
--      untouched.
--   2. BADGE. The claimed owner is a real `super_agent` carrying the
--      `enterprise` badge in `app_metadata` - the same gate `createSubAgent`
--      enforces before it will create a sub agent at all, and not writable by
--      the account holder.
--   3. TABLE SHAPE. `agent_orders` additionally requires
--      `buyer_type = 'sub_agent'`, so an ordinary customer's order can never be
--      swept in by mistake.
--
-- A row failing ANY condition is LEFT ALONE. It is not guessed at and not
-- reassigned: a wrong owner routes real money toward the wrong wallet, which
-- is strictly worse than a missing one that merely renders invisibly.
--
-- The same verified pairing is then applied to `payment_transactions`, so the
-- two tables cannot end up disagreeing with each other or with `user_profiles`.
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT CHANGED
-- -------------------------------
-- No status is rewritten. `agent_orders.status` and
-- `payment_transactions.status` are left exactly as they are: these orders were
-- paid for and dispatched, and the status reflects the provider. Rewriting a
-- settled order's status would desynchronise it from the provider and from the
-- payment record, and would break the held-order reorder path for no benefit.
--
-- No wallet is debited. See the `isSubAgentOrder` note above - these orders were
-- never charged to a wallet in the first place, so charging one now would take
-- money that was never committed to this purchase. Recovering the missing
-- attribution is correct; retroactively moving money is not, and it is a
-- separate, deliberate financial decision.
-- ---------------------------------------------------------------------------
-- `wallet_topups` IS DELIBERATELY NOT TOUCHED
-- -------------------------------------------
-- An earlier draft of this file tried to repair `wallet_topups.super_agent_id`.
-- That column does not exist and never did. Migration 20260928_007 replaced it
-- with `wallet_owner_id`, and the client reads that:
--
--     fetchSubAgentTopups -> .or(`wallet_owner_id.eq.${userId},
--                                  agent_id.eq.${userId}`)
--
-- An unassigned sub agent was refused by `verify-wallet-topup` with 403 BEFORE
-- Paystack, so no such top-up ever settled and there is nothing to recover.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. agent_orders
-- ---------------------------------------------------------------------------
-- The row the SUPER AGENT acts on: it drives the Transactions screen and the
-- held-order reorder.
--
-- `updated_at` is deliberately absent - `agent_orders` has no such column, and
-- adding one to a table this large is not worth a backfill's worth of rewrite.
-- `created_at` is left alone for the same reason.
UPDATE public.agent_orders ao
SET super_agent_id = resolved.owner_id
FROM (
  SELECT ao.id AS id, claim.owner_id AS owner_id
  FROM public.agent_orders ao
  -- The sub agent's own REPAIRED, admin-written owner (condition 1).
  JOIN public.user_profiles mine
    ON mine.id = ao.agent_id
  -- The owner the account CLAIMS, via self-written metadata. A candidate only.
  JOIN LATERAL (
    SELECT NULLIF(btrim(u.raw_user_meta_data ->> 'super_agent_id'), '')::uuid AS owner_id
    FROM auth.users u
    WHERE u.id = ao.agent_id
  ) AS claim ON TRUE
  -- ...which must be a real, badge-authorised super agent (condition 2).
  JOIN public.user_profiles owner_profile
    ON owner_profile.id = claim.owner_id
   AND lower(btrim(COALESCE(owner_profile.role, '')))
       IN ('super_agent', 'superagent', 'super-agent', 'super agent')
  JOIN auth.users owner_auth
    ON owner_auth.id = claim.owner_id
   AND lower(btrim(COALESCE(owner_auth.raw_app_meta_data ->> 'super_agent_badge', ''))) = 'enterprise'
  WHERE ao.super_agent_id IS NULL
    AND ao.buyer_type = 'sub_agent'                      -- condition 3
    AND lower(btrim(COALESCE(mine.role, ''))) IN ('sub_agent', 'subagent', 'agent')
    -- (1) THE CROSS-CHECK: repaired profile already agrees with the claim.
    AND mine.super_agent_id IS NOT DISTINCT FROM claim.owner_id
) AS resolved
WHERE ao.id = resolved.id
  AND ao.super_agent_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. payment_transactions
-- ---------------------------------------------------------------------------
-- `user_id` is the payer, so it names the sub agent directly - no join to
-- `agent_orders` is needed, and the owner is resolved through the SAME verified
-- pairing as section 1 rather than through a repaired row. Deriving it from the
-- sub agent's repaired profile means a payment row whose `order_id` predates
-- the agent table is still covered, and the two tables cannot drift.
--
-- `order_type = 'agent'` excludes ordinary customers: it is a NOT NULL column
-- constrained to exactly ('regular', 'agent') and stamped by the same
-- `isAgentOrder` that chose the table.
UPDATE public.payment_transactions pt
SET super_agent_id = resolved.owner_id
FROM (
  SELECT pt.id AS id, claim.owner_id AS owner_id
  FROM public.payment_transactions pt
  JOIN LATERAL (
    SELECT NULLIF(btrim(u.raw_user_meta_data ->> 'super_agent_id'), '')::uuid AS owner_id
    FROM auth.users u
    WHERE u.id = pt.user_id
  ) AS claim ON TRUE
  JOIN public.user_profiles mine
    ON mine.id = pt.user_id
   AND lower(btrim(COALESCE(mine.role, ''))) IN ('sub_agent', 'subagent', 'agent')
   -- (1) THE CROSS-CHECK.
   AND mine.super_agent_id IS NOT DISTINCT FROM claim.owner_id
  -- (2) THE BADGE.
  JOIN public.user_profiles owner_profile
    ON owner_profile.id = claim.owner_id
   AND lower(btrim(COALESCE(owner_profile.role, '')))
       IN ('super_agent', 'superagent', 'super-agent', 'super agent')
  JOIN auth.users owner_auth
    ON owner_auth.id = claim.owner_id
   AND lower(btrim(COALESCE(owner_auth.raw_app_meta_data ->> 'super_agent_badge', ''))) = 'enterprise'
  WHERE pt.super_agent_id IS NULL
    AND lower(btrim(COALESCE(pt.order_type, ''))) = 'agent'
    AND claim.owner_id IS NOT NULL
) AS resolved
WHERE pt.id = resolved.id
  AND pt.super_agent_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Verify - run AFTER committing
-- ---------------------------------------------------------------------------
-- Expect ZERO rows left holding a sub-agent payer and no owner:
--
--   SELECT count(*) AS still_unowned
--     FROM public.agent_orders ao
--    WHERE ao.super_agent_id IS NULL AND ao.buyer_type = 'sub_agent';
--
--   SELECT count(*) AS still_unowned
--     FROM public.payment_transactions pt
--    WHERE pt.super_agent_id IS NULL AND pt.order_type = 'agent';
--
-- Then confirm they are visible under the super agent's id:
--
--   SELECT ao.id, ao.status, ao.super_agent_id, ao.created_at
--     FROM public.agent_orders ao
--    WHERE ao.buyer_type = 'sub_agent'
--    ORDER BY ao.created_at DESC
--    LIMIT 20;
--
-- Rows STILL NULL are exactly those that failed a cross-check above - most
-- often a sub agent whose self-written metadata and repaired profile disagree.
-- Those need a human decision about who really owns them, and were
-- deliberately not guessed.
--
-- REGRESSION CHECK: `ANALYZE public.agent_orders;` and the same for
-- `payment_transactions`. Both are filtered by `super_agent_id` on the request
-- path, and a bulk UPDATE can leave the planner on a stale index estimate.
--
-- RLS note: this runs as the migration owner, which bypasses RLS. The policies
-- added in 20261003_002 are unchanged - this migration only fills in a value
-- they already key on.

COMMIT;
