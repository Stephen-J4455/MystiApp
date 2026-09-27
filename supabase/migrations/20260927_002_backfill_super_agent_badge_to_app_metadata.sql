-- Backfill super_agent_badge into auth.users.raw_app_meta_data
--
-- WHY
-- The five Enterprise gates (paystack-subaccount, super-agent-offers,
-- super-agent-tier-management, super-agent-user-management, admin-users)
-- read the badge from `app_metadata` ONLY, because `user_metadata` is
-- writable by the user via auth.updateUser() and would let any Pro super
-- agent grant themselves the Enterprise capability.
--
-- But every write path in `admin-users` put the badge in `user_metadata`
-- ONLY. Nothing ever populated `app_metadata.super_agent_badge`, so the
-- gate read "" on every account, failed closed, and returned:
--     403 "The Pro badge does not include ... access"
--
-- Verified against live data before writing this migration: 20 super
-- agents, every one with badge_user='pro'/'enterprise' and badge_app=''.
--
-- `admin-users` now mirrors the badge into BOTH stores. This migration
-- repairs the accounts that were written under the old behaviour, so
-- existing Enterprise super agents are not locked out until an admin
-- happens to re-save their role.
--
-- Safe to re-run: it only ever copies a value that exists in
-- raw_user_meta_data, and never invents one.
--
-- NOTE: auth.users is not writable by this project's normal roles; this
-- runs as the migration owner, which is why the same statement is not
-- possible from an edge function.

DO $backfill$
DECLARE
  migrated integer := 0;
BEGIN
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object(
         'super_agent_badge',
         lower(raw_user_meta_data ->> 'super_agent_badge')
       )
  WHERE raw_user_meta_data ->> 'super_agent_badge' IS NOT NULL
    AND lower(raw_user_meta_data ->> 'super_agent_badge') IN ('pro', 'enterprise')
    AND COALESCE(raw_app_meta_data ->> 'super_agent_badge', '') IS DISTINCT FROM
        lower(raw_user_meta_data ->> 'super_agent_badge');

  GET DIAGNOSTICS migrated = ROW_COUNT;

  IF migrated > 0 THEN
    RAISE NOTICE 'Backfilled super_agent_badge into app_metadata for % account(s)', migrated;
  ELSE
    RAISE NOTICE 'No super_agent_badge needed backfilling (already present or absent)';
  END IF;
END
$backfill$;
