BEGIN;

ALTER TABLE public.super_agent_offers
  ADD COLUMN IF NOT EXISTS uses_admin_base_price boolean NOT NULL DEFAULT false;

UPDATE public.super_agent_offers AS offer
SET uses_admin_base_price = true
WHERE EXISTS (
  SELECT 1
  FROM public.package_pricing AS pricing
  WHERE pricing.provider = offer.provider
    AND UPPER(TRIM(pricing.network)) = UPPER(TRIM(offer.network))
    AND UPPER(TRIM(offer.data_value)) IN (
      UPPER(TRIM(pricing.type)),
      UPPER(TRIM(pricing.type || ' - ' || pricing.size || 'GB')),
      UPPER(TRIM(pricing.type || ' (' || pricing.size || 'GB)'))
    )
    AND pricing.base_price = offer.price
);

COMMIT;
