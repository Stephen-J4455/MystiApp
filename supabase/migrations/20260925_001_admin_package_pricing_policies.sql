BEGIN;

-- Keep pricing writes available to signed-in administrators even if a client
-- still uses the public Supabase client. Edge Function writes remain
-- preferred because they use the service role after admin authentication.
CREATE OR REPLACE FUNCTION public.is_mysti_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT lower(COALESCE(
    auth.jwt() -> 'app_metadata' ->> 'role',
    auth.jwt() -> 'user_metadata' ->> 'role',
    ''
  )) = 'admin';
$$;

REVOKE ALL ON FUNCTION public.is_mysti_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_mysti_admin() TO authenticated;

ALTER TABLE public.package_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.normal_user_package_pricing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read all package pricing" ON public.package_pricing;
CREATE POLICY "Admins can read all package pricing"
ON public.package_pricing
FOR SELECT
TO authenticated
USING (public.is_mysti_admin() OR is_active = true);

DROP POLICY IF EXISTS "Admins can insert package pricing" ON public.package_pricing;
CREATE POLICY "Admins can insert package pricing"
ON public.package_pricing
FOR INSERT
TO authenticated
WITH CHECK (public.is_mysti_admin());

DROP POLICY IF EXISTS "Admins can update package pricing" ON public.package_pricing;
CREATE POLICY "Admins can update package pricing"
ON public.package_pricing
FOR UPDATE
TO authenticated
USING (public.is_mysti_admin())
WITH CHECK (public.is_mysti_admin());

DROP POLICY IF EXISTS "Admins can delete package pricing" ON public.package_pricing;
CREATE POLICY "Admins can delete package pricing"
ON public.package_pricing
FOR DELETE
TO authenticated
USING (public.is_mysti_admin());

DROP POLICY IF EXISTS "Admins can read all normal user package pricing" ON public.normal_user_package_pricing;
CREATE POLICY "Admins can read all normal user package pricing"
ON public.normal_user_package_pricing
FOR SELECT
TO authenticated
USING (public.is_mysti_admin() OR is_active = true);

DROP POLICY IF EXISTS "Admins can insert normal user package pricing" ON public.normal_user_package_pricing;
CREATE POLICY "Admins can insert normal user package pricing"
ON public.normal_user_package_pricing
FOR INSERT
TO authenticated
WITH CHECK (public.is_mysti_admin());

DROP POLICY IF EXISTS "Admins can update normal user package pricing" ON public.normal_user_package_pricing;
CREATE POLICY "Admins can update normal user package pricing"
ON public.normal_user_package_pricing
FOR UPDATE
TO authenticated
USING (public.is_mysti_admin())
WITH CHECK (public.is_mysti_admin());

DROP POLICY IF EXISTS "Admins can delete normal user package pricing" ON public.normal_user_package_pricing;
CREATE POLICY "Admins can delete normal user package pricing"
ON public.normal_user_package_pricing
FOR DELETE
TO authenticated
USING (public.is_mysti_admin());

COMMIT;
