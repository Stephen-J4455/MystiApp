BEGIN;

CREATE TABLE IF NOT EXISTS public.data_provider_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  provider text NOT NULL DEFAULT 'jehuca'
    CHECK (provider IN ('jehuca', 'bisdel')),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.data_provider_settings (id, provider)
VALUES (true, 'jehuca')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.data_provider_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_provider_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.data_provider_settings TO service_role;

ALTER TABLE public.package_pricing
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'jehuca'
    CHECK (provider IN ('jehuca', 'bisdel'));

ALTER TABLE public.normal_user_package_pricing
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'jehuca'
    CHECK (provider IN ('jehuca', 'bisdel'));

ALTER TABLE public.package_pricing
  DROP CONSTRAINT IF EXISTS package_pricing_network_type_unique;

ALTER TABLE public.package_pricing
  ADD CONSTRAINT package_pricing_provider_network_type_unique
    UNIQUE (provider, network, type);

ALTER TABLE public.normal_user_package_pricing
  DROP CONSTRAINT IF EXISTS normal_user_package_pricing_network_type_unique;

ALTER TABLE public.normal_user_package_pricing
  ADD CONSTRAINT normal_user_package_pricing_provider_network_type_unique
    UNIQUE (provider, network, type);

CREATE INDEX IF NOT EXISTS idx_package_pricing_provider_active
  ON public.package_pricing(provider, is_active);

CREATE INDEX IF NOT EXISTS idx_normal_user_package_pricing_provider_active
  ON public.normal_user_package_pricing(provider, is_active);

ALTER TABLE public.api_cost_settings
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'jehuca'
    CHECK (provider IN ('jehuca', 'bisdel'));

ALTER TABLE public.api_cost_settings
  DROP CONSTRAINT IF EXISTS api_cost_settings_audience_network_type_unique;

ALTER TABLE public.api_cost_settings
  ADD CONSTRAINT api_cost_settings_audience_provider_network_type_unique
    UNIQUE (audience, provider, network, type);

CREATE INDEX IF NOT EXISTS idx_api_cost_settings_provider_package
  ON public.api_cost_settings(provider, audience, package_id);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'jehuca'
    CHECK (provider_name IN ('jehuca', 'bisdel')),
  ADD COLUMN IF NOT EXISTS provider_order_id text;

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'jehuca'
    CHECK (provider_name IN ('jehuca', 'bisdel')),
  ADD COLUMN IF NOT EXISTS provider_order_id text;

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'jehuca'
    CHECK (provider_name IN ('jehuca', 'bisdel')),
  ADD COLUMN IF NOT EXISTS provider_order_id text;

CREATE OR REPLACE FUNCTION public.resolve_api_cost(
  p_audience text,
  p_network text,
  p_type text,
  p_package_id text,
  p_live_cost numeric,
  p_fallback numeric,
  p_provider text
)
RETURNS TABLE (
  api_cost numeric,
  cost_source text,
  discount numeric,
  notes text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tier public.api_cost_settings%ROWTYPE;
  v_live numeric;
  v_base numeric;
  v_discount numeric := 0;
  v_audience text := COALESCE(NULLIF(TRIM(p_audience), ''), 'super_agent');
  v_provider text := COALESCE(NULLIF(TRIM(p_provider), ''), 'jehuca');
  v_package_id text := NULLIF(TRIM(p_package_id), '');
BEGIN
  v_live := COALESCE(p_live_cost, p_fallback);
  v_base := COALESCE(v_live, 0);

  IF v_package_id IS NOT NULL THEN
    SELECT * INTO v_tier
    FROM public.api_cost_settings AS s
    WHERE s.audience = v_audience
      AND s.provider = v_provider
      AND s.is_active = true
      AND s.package_id = v_package_id
    ORDER BY (s.discount > 0) DESC
    LIMIT 1;
  END IF;

  IF v_package_id IS NULL OR NOT FOUND THEN
    SELECT * INTO v_tier
    FROM public.api_cost_settings AS s
    WHERE s.audience = v_audience
      AND s.provider = v_provider
      AND s.is_active = true
      AND UPPER(TRIM(s.network)) = UPPER(TRIM(p_network))
      AND UPPER(TRIM(s.type)) = UPPER(TRIM(p_type))
    ORDER BY (s.package_id IS NOT NULL) DESC
    LIMIT 1;
  END IF;

  IF FOUND THEN
    v_discount := COALESCE(v_tier.discount, 0);
  END IF;

  RETURN QUERY
  SELECT
    ROUND(GREATEST(v_base - v_discount, 0), 2),
    CASE
      WHEN v_discount > 0 THEN 'api_cost_discount'
      WHEN v_live IS NOT NULL THEN 'provider_price'
      ELSE 'fallback'
    END,
    v_discount,
    v_tier.notes;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_api_cost(text, text, text, text, numeric, numeric, text)
TO authenticated, anon, service_role;

-- Preserve the old Jehuca-only signature for any still-deployed caller.
CREATE OR REPLACE FUNCTION public.resolve_api_cost(
  p_audience text,
  p_network text,
  p_type text,
  p_package_id text,
  p_live_cost numeric,
  p_fallback numeric
)
RETURNS TABLE (
  api_cost numeric,
  cost_source text,
  discount numeric,
  notes text
)
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.resolve_api_cost(
    p_audience,
    p_network,
    p_type,
    p_package_id,
    p_live_cost,
    p_fallback,
    'jehuca'
  );
$$;

GRANT EXECUTE ON FUNCTION public.resolve_api_cost(text, text, text, text, numeric, numeric)
TO authenticated, anon, service_role;

COMMIT;
