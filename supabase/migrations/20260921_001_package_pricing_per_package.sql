-- Migration: 20260921_001_package_pricing_per_package.sql
-- Enables per-package base pricing support in package_pricing table.
-- Packages are identified by their unique bundle descriptor (e.g. 'ISHARE - 1GB')
-- or package_id, rather than grouping all sizes under a single bundle type.

BEGIN;

-- 1. Optional helper columns if schema is migrated to explicit package_id/size columns in future:
ALTER TABLE IF EXISTS public.package_pricing
  ADD COLUMN IF NOT EXISTS package_id text,
  ADD COLUMN IF NOT EXISTS size numeric;

-- 2. Index on package_id if column exists
CREATE INDEX IF NOT EXISTS idx_package_pricing_package_id
  ON public.package_pricing (package_id);

CREATE INDEX IF NOT EXISTS idx_package_pricing_type
  ON public.package_pricing (type);

COMMIT;
