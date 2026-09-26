BEGIN;

-- ===========================================================================
-- Remove user_metadata legs from RLS policies
-- ===========================================================================
-- Migrations 20260925_001 and 20260926_005 added RLS policies whose USING /
-- WITH CHECK clauses read:
--
--   (auth.jwt() -> 'user_metadata' ->> 'role') = 'Admin'
--
-- `auth.jwt() -> 'user_metadata'` is the SELF-SERVICE half of the token. Any
-- authenticated client can rewrite it with
-- `supabase.auth.updateUser({ data: { role: 'Admin' } })`, so a policy built on
-- it grants itself the permission it is trying to restrict. These policies are
-- therefore weaker than they look.
--
-- The `app_metadata` leg is safe: it is written only by the service role.
--
-- Scope note - what this does and does not fix:
--   - Tables covered here: api_cost_settings, afa_registration_settings,
--     super_agent_afa_pricing
--   - Deliberately NOT covered: afa_registrations, afa_payment_ledger,
--     payment_charge_settings, super_agent_wallets,
--     super_agent_wallet_ledger. Those rely on `auth.uid()` ownership scoping
--     (a sub-agent reading their own wallet) rather than a role comparison, and
--     rewriting them is a separate, larger change with real regression risk.
--     They are called out at the end of this file as remaining work.
--
-- Note that dropping and recreating a policy is fine here: the recreated
-- policy is strictly NARROWER, so no grant is widened at any point.

-- ---------------------------------------------------------------------------
-- api_cost_settings
-- ---------------------------------------------------------------------------
-- WORSE than a user_metadata leg: migration 20260926_003 created these three
-- WRITE policies with no role check at all - `WITH CHECK (true)`. That means
-- ANY authenticated user could insert, update or delete provider cost
-- settings, i.e. rewrite what every future order is snapshotted against. This
-- is fixed here.
--
-- The read policy stays `USING (true)` on purpose: the Data Screen needs to
-- read cost settings to show prices, and it already reads them through the
-- anon key. Reading is not the risk; writing is.
DROP POLICY IF EXISTS "Admins can insert api cost settings"
  ON public.api_cost_settings;
CREATE POLICY "Admins can insert api cost settings"
  ON public.api_cost_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_mysti_admin());

DROP POLICY IF EXISTS "Admins can update api cost settings"
  ON public.api_cost_settings;
CREATE POLICY "Admins can update api cost settings"
  ON public.api_cost_settings
  FOR UPDATE
  TO authenticated
  USING (public.is_mysti_admin())
  WITH CHECK (public.is_mysti_admin());

DROP POLICY IF EXISTS "Admins can delete api cost settings"
  ON public.api_cost_settings;
CREATE POLICY "Admins can delete api cost settings"
  ON public.api_cost_settings
  FOR DELETE
  TO authenticated
  USING (public.is_mysti_admin());

-- ---------------------------------------------------------------------------
-- is_mysti_admin() - the shared helper many policies depend on
-- ---------------------------------------------------------------------------
-- This is the highest-leverage fix in the file. It was defined in
-- 20260925_001 as:
--
--   lower(COALESCE(
--     auth.jwt() -> 'app_metadata' ->> 'role',
--     auth.jwt() -> 'user_metadata' ->> 'role',
--     ''
--   )) = 'admin'
--
-- The `user_metadata` fallback makes the whole helper - and therefore EVERY
-- policy that calls it - self-service escalation: set `role: 'admin'` in your
-- own metadata and `is_mysti_admin()` returns true.
--
-- Redefined to read `app_metadata` only. Every dependent policy
-- (package_pricing, normal_user_package_pricing, and the ones added above)
-- becomes correctly gated as a side effect, with no need to touch each one.
--
-- This is STRICTLY NARROWER, so no policy is widened. The one thing to check
-- before applying: if a real admin account has its role ONLY in
-- `user_metadata`, they will lose direct table access. Edge functions are
-- unaffected - they use the service role - so the admin app keeps working
-- through them. Verify with the query at the end of this file.
CREATE OR REPLACE FUNCTION public.is_mysti_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT lower(COALESCE(
    auth.jwt() -> 'app_metadata' ->> 'role',
    ''
  )) IN ('admin');
$$;

REVOKE ALL ON FUNCTION public.is_mysti_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_mysti_admin() TO authenticated;

-- ---------------------------------------------------------------------------
-- afa_registration_settings
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS afa_settings_super_agent_read
  ON public.afa_registration_settings;
CREATE POLICY afa_settings_super_agent_read
  ON public.afa_registration_settings
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN
      ('Admin', 'admin', 'SuperAgent', 'superagent', 'super_agent')
  );

-- ---------------------------------------------------------------------------
-- super_agent_afa_pricing
-- ---------------------------------------------------------------------------
-- The owner leg (`super_agent_id = auth.uid()`) is already safe: it compares
-- against the caller's own id, not a self-declared role. Only the admin leg
-- needs narrowing.
DROP POLICY IF EXISTS super_agent_afa_pricing_admin_all
  ON public.super_agent_afa_pricing;
CREATE POLICY super_agent_afa_pricing_admin_all
  ON public.super_agent_afa_pricing
  FOR ALL TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Admin', 'admin'))
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Admin', 'admin'));

-- ---------------------------------------------------------------------------
-- REMAINING WORK - deliberately not done here
-- ---------------------------------------------------------------------------
-- These tables still have `user_metadata` role legs from their original
-- migrations. Tightening them needs care because their non-admin access is
-- ownership-scoped rather than role-scoped, so a blind rewrite would change
-- who can read their own rows:
--
--   public.payment_charge_settings
--   public.payment_transactions
--   public.afa_registrations
--   public.afa_payment_ledger
--   public.super_agent_wallets
--   public.super_agent_wallet_ledger
--
-- Recommended approach when you pick this up: for each, confirm which screens
-- read it with the anon key, decide whether admin access should come from
-- `user_profiles` (a join, since RLS cannot read another table) or from a
-- SECURITY DEFINER helper, and drop the `user_metadata` leg last so access is
-- never widened mid-change.
--
-- Read the current state before changing anything:
--
--   SELECT tablename, policyname, cmd, qual, with_check
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (qual LIKE '%user_metadata%' OR with_check LIKE '%user_metadata%')
--    ORDER BY tablename, policyname;
--
-- After applying this migration, `is_mysti_admin()`-based policies no longer
-- contain a `user_metadata` reference even though their `qual` still says
-- `is_mysti_admin()`. To confirm the helper itself is clean:
--
--   SELECT pg_get_functiondef('public.is_mysti_admin()'::regproc);
--
-- Sanity check that a real admin still passes, and a normal user does not.
-- Run as an authenticated admin session, not as the service role:
--
--   SELECT public.is_mysti_admin() AS should_be_true;
--
-- Confirm at least one admin account carries its role in app_metadata, not
-- only in user_metadata. If any admin relies on user_metadata alone, migrate
-- them first or they will lose direct table access (edge functions are
-- unaffected - they use the service role):
--
--   SELECT id, email,
--          raw_app_meta_data ->> 'role' AS app_role,
--          raw_user_meta_data ->> 'role' AS user_role
--     FROM auth.users
--    WHERE lower(COALESCE(raw_app_meta_data ->> 'role', '')) <> 'admin'
--      AND lower(COALESCE(raw_user_meta_data ->> 'role', '')) = 'admin';

COMMIT;
