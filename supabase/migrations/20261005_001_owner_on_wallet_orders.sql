BEGIN;

-- ===========================================================================
-- Attribute wallet-funded orders to the Super Agent who owns the buyer
-- ===========================================================================
-- APPLY AFTER: 20261004_004 (super_agent_profit_from_admin_base_price)
--
-- WHY THIS IS NEEDED
-- ------------------
-- A sub-agent's order reaches `verify-payment` and takes ONE of two branches,
-- chosen by how it was PAID FOR:
--
--   paid by Paystack -> agent_orders  (stamped super_agent_id)
--   paid from wallet -> orders        (stamped with NOTHING)
--
-- The wallet branch is a super agent's purchase flow, so it writes to the
-- customer table `orders`. That was correct when only super agents had wallets.
-- It stopped being correct when sub agents were given mirrored balances that
-- spend from the same real wallet - and their orders became invisible to the
-- very person whose money they spent.
--
-- WHY IT IS INVISIBLE
-- -------------------
-- Every super-agent read of orders filters on ownership:
--
--     fetchSubAgentOrders   agent_orders         WHERE super_agent_id = <me>
--     fetchSubAgentPayments payment_transactions WHERE super_agent_id = <me>
--
-- A wallet order is in neither of those tables, and `orders` had no
-- `super_agent_id` column at all, so there was nothing to filter on. The
-- read succeeds and returns an empty list - HTTP 200, no error. A super agent
-- whose sub-agent bought from a wallet balance saw no order anywhere, with
-- nothing in the logs to explain it.
--
-- WHY THE LEDGER PAGE KEPT WORKING
-- -------------------------------
-- `super_agent_wallet_ledger` is keyed on the WALLET HOLDER, not on the order.
-- The mirror debit credits the super agent's real wallet, so that row lands
-- under their id no matter which table the purchase was recorded in. The ledger
-- therefore proved the money moved while the order row stayed unowned and
-- unreadable - which is exactly the split being reported: wallet movements
-- visible, orders missing.
--
-- It is NOT the historic-null problem
-- ---------------------------------
-- Migration 20261004_002 backfilled NULL owners onto orders placed by sub
-- agents who had no owner AT ALL. Those accounts were broken in a different
-- way, and no wallet purchase could ever have succeeded for them: the wallet
-- path rejects an ownerless sub agent with 403 before it debits anything.
--
-- The accounts this migration fixes were never broken. They have an owner, the
-- debit succeeded, the ledger row exists - and the order is still invisible,
-- because the wallet branch never wrote the owner's id anywhere. Repairing
-- those rows' `super_agent_id` to NULL would not have found them either, and
-- the previous diagnosis was wrong about which rows were at fault.
--
-- THE FIX
-- -------
-- 1. Give `orders` the ownership column it never had.
-- 2. Back-fill it for the wallet purchases that already happened.
-- 3. Index it, so the roster query does not degrade into a sequential scan
--    once an agent has real order volume.
--
-- Back-fill safety
-- ----------------
-- An owner is recovered ONLY where two independent records already agree:
--
--   - `user_profiles.super_agent_id`, admin-written and never self-written
--   - `payment_transactions.super_agent_id` for the same purchase
--
-- `payment_transactions` is the stronger of the two: the settlement ran, so
-- the wallet WAS debited, and a debit can only have been taken from a real
-- owner's wallet. Where the two disagree, or either is NULL, the row is LEFT
-- ALONE - reassigning an order to a guessed owner would attribute real spend
-- to somebody who may not have paid for it, which is worse than an order that
-- renders invisibly.
--
-- Restricted to `buyer_type = 'sub_agent'`: a super agent's own wallet
-- purchase must keep a NULL owner, because nobody is above them. That is the
-- same rule `verify-payment` now applies on the write path.
--
-- NOT BACK-FILLED: any status, amount or settlement column. These orders were
-- paid for and dispatched and every one of those fields reflects the provider.
-- This migration only restores attribution; it moves no money and changes no
-- lifecycle state.
-- ---------------------------------------------------------------------------

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS super_agent_id uuid
  REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.orders.super_agent_id IS
  'The Super Agent who owns the BUYER, for wallet-funded orders. NULL for a Super Agent''s own purchase (they are top of the hierarchy) and for a normal customer''s Paystack order. Set by verify-payment on the wallet path; the Paystack path writes to agent_orders instead, which has always carried its own super_agent_id.';

-- Only wallet-funded sub-agent purchases are back-filled. `buyer_type` is the
-- buyer''s identity - migration 20261004_003 corrected it to stop conflating
-- that with where the money came from - so it is the honest predicate here.
--
-- Both sides of the pairing must be non-NULL and equal. See the header for why.
UPDATE public.orders o
   SET super_agent_id = pt.super_agent_id
  FROM public.payment_transactions pt
 WHERE pt.order_id = o.id
   AND pt.order_type = 'regular'
   AND pt.super_agent_id IS NOT NULL
   AND o.super_agent_id IS DISTINCT FROM pt.super_agent_id
   AND o.buyer_type = 'sub_agent'
   AND EXISTS (
         SELECT 1
           FROM public.user_profiles up
          WHERE up.id = o.user_id
            AND up.super_agent_id = pt.super_agent_id
       );

CREATE INDEX IF NOT EXISTS idx_orders_super_agent_created
  ON public.orders (super_agent_id, created_at DESC);

-- Wallet-funded orders are read alongside `agent_orders` on the roster tab, so
-- the partial index only has to carry the rows the roster query can reach.
CREATE INDEX IF NOT EXISTS idx_orders_wallet_sub_agent_owner
  ON public.orders (super_agent_id, created_at DESC)
  WHERE super_agent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- `public.orders` has no SELECT policy anywhere in this schema, so RLS has
-- never been enabled on it and this read succeeds today without one. The policy
-- below is therefore not what makes the roster tab work - it is what stops that
-- working BY ACCIDENT once somebody enables RLS on this table.
--
-- Without it, enabling RLS with only an admin policy would silently empty the
-- super agent's roster tab: no error, no rows, exactly the symptom this whole
-- migration exists to remove. Declared now so the access is explicit and the
-- column that grants it is documented in the same place as the column itself.
--
-- Scoped to rows the caller OWNS. Deliberately narrower than the existing
-- `agent_orders_read_by_super_agent`, which is likewise `super_agent_id =
-- auth.uid()`, so the two tables grant the same authority in the same terms.
DROP POLICY IF EXISTS orders_read_by_super_agent ON public.orders;
CREATE POLICY orders_read_by_super_agent
  ON public.orders FOR SELECT
  TO authenticated
  USING (super_agent_id = (SELECT auth.uid()));

-- The buyer still reads their own order. Without this leg a sub agent who paid
-- from a wallet would lose sight of their own purchase the moment RLS is
-- enabled, which is the mirror image of the bug being fixed.
DROP POLICY IF EXISTS orders_read_own ON public.orders;
CREATE POLICY orders_read_own
  ON public.orders FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- 1. The column exists and is nullable, so historic Paystack rows are untouched:
--
--    SELECT column_name, data_type, is_nullable
--      FROM information_schema.columns
--     WHERE table_name = 'orders' AND column_name = 'super_agent_id';
--
-- 2. Back-filled rows are exactly the ones where both records agreed:
--
--    SELECT count(*) AS backfilled
--      FROM public.orders
--     WHERE super_agent_id IS NOT NULL
--       AND buyer_type = 'sub_agent';
--
-- 3. A super agent's OWN wallet purchase still reads NULL - the predicate must
--    not have claimed them:
--
--    SELECT count(*) AS wrongly_owned
--      FROM public.orders
--     WHERE super_agent_id IS NOT NULL
--       AND buyer_type = 'super_agent';
--
--    Expect 0.
--
-- 4. No order is owned by somebody other than their profile's owner:
--
--    SELECT count(*) AS mismatched
--      FROM public.orders o
--      JOIN public.user_profiles up ON up.id = o.user_id
--     WHERE o.super_agent_id IS NOT NULL
--       AND up.super_agent_id IS DISTINCT FROM o.super_agent_id;
--
--    Expect 0. Anything above it was deliberately left alone, not guessed at.
--
-- 5. `ANALYZE public.orders;` - the back-fill is a bulk UPDATE.
-- ---------------------------------------------------------------------------

COMMIT;