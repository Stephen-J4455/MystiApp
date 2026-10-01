BEGIN;

-- ===========================================================================
-- Put `orders` and `agent_orders` on the realtime publication
-- ===========================================================================
-- WHY
-- ---
-- The admin Orders screen reloads on mount, filter change and pull-to-refresh
-- only. Everything between those three moments is invisible: an order placed
-- while the screen is open simply does not appear until the admin pulls to
-- refresh, and a status change made elsewhere is not reflected either.
--
-- This migration is the DATABASE half of that fix. It is required, not
-- optional: Supabase Realtime only delivers `postgres_changes` for tables that
-- are members of the `supabase_realtime` publication, and a table that is
-- missing from it produces a subscription that CONNECTS CLEANLY AND THEN
-- SILENTLY RECEIVES NOTHING. The same trap is called out in
-- 20260928_004_user_profiles_realtime_rls.sql, which is the only other
-- migration in this repo that touches the publication.
--
-- That failure mode is the dangerous one: a client-side implementation looks
-- correct, logs no error, and delivers zero events - so "the realtime code is
-- broken" and "the migration never ran" are indistinguishable from the UI
-- alone. Check `pg_publication_tables` before debugging the client.
--
-- SECURITY
-- --------
-- This migration does NOT change RLS. Realtime honours the table's existing
-- SELECT policies, and it delivers a row to a subscriber only when that
-- subscriber can already read the row through PostgREST. Adding a table to the
-- publication therefore cannot widen who can read it - it can only tell the
-- client about rows the client was already entitled to fetch.
--
-- Enabling RLS on these two tables was deliberately NOT done here. The admin
-- reads go through the anon key as an authenticated admin, keyed on
-- `is_mysti_admin()`, and that works today. Turning RLS on without a live
-- Postgres to verify against would also gate the MAIN app's own-order history
-- reads, which are keyed on the buyer's id. A change that can lock the customer
-- app out of its own purchase history is not a safe thing to ship unread.
-- The publication membership and the SELECT policies are therefore left exactly
-- as they are; if a policy audit is wanted, that is its own migration.
--
-- One consequence worth stating: `orders` holds customer names, phone numbers
-- and email addresses. Whatever the current policies allow to SELECT today is
-- exactly what realtime will now also stream. Confirm the admin policy is
-- genuinely admin-scoped before applying this, because the anon key ships in
-- the app bundle.
-- ===========================================================================

-- Postgres raises "relation is already member of publication" if a table is
-- added twice, so guard on pg_publication_tables. Without the guard,
-- re-running this migration errors instead of being a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'agent_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_orders;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- REPLICA IDENTITY
-- ---------------------------------------------------------------------------
-- Stated explicitly rather than left to whatever the tables already carry,
-- because the client UPDATE handler depends on it.
--
-- Both tables are keyed on `id`, so an UPDATE needs to carry only that key for
-- Postgres to identify the row. Two identities matter here:
--
--   DEFAULT - the payload carries the primary key PLUS ONLY THE CHANGED
--              columns. Correct and cheap, but it means `payload.new` on an
--              UPDATE is a PARTIAL row.
--   FULL    - the entire new row plus the entire old row is replicated on
--              every change. Convenient for clients, but it doubles the
--              replication volume for two of the busiest tables in the
--              database and was explicitly rejected in 20260928_004 for
--              `user_profiles` on exactly this reasoning.
--
-- DEFAULT is kept, and the client merges the partial payload over the row it
-- already has rather than replacing it. Setting FULL here to make the client's
-- life easier would trade a real cost on every order write for a convenience
-- the merge already provides.
--
-- The consequence to keep in mind: on a DELETE the payload carries the primary
-- key ONLY, so `payload.old` will NOT include `order_type`/`status` and a
-- handler cannot classify which table a deletion came from. Each table is
-- therefore bound to its own handler in the client, with the type closed over,
-- instead of being inferred from the payload.
ALTER TABLE public.orders
  REPLICA IDENTITY DEFAULT;
ALTER TABLE public.agent_orders
  REPLICA IDENTITY DEFAULT;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Both tables should now appear in the publication:
--
--   SELECT pubname, schemaname, tablename
--     FROM pg_publication_tables
--    WHERE pubname = 'supabase_realtime'
--    ORDER BY tablename;
--
-- And the identity should read back as 'd' (DEFAULT) for each:
--
--   SELECT c.relname, c.relreplident
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname IN ('orders', 'agent_orders');
--
-- If the first query does not list both tables, realtime on the admin Orders
-- screen will connect and deliver nothing, with no error anywhere.

COMMIT;
