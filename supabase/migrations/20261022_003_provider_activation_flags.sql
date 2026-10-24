BEGIN;

ALTER TABLE public.data_provider_settings
  ADD COLUMN IF NOT EXISTS jehuca_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bisdel_enabled boolean NOT NULL DEFAULT false;

COMMIT;
