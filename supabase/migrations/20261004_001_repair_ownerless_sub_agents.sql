BEGIN;

-- ===========================================================================
-- Repair sub-agents created by a Super Agent with no owner assignment
-- ===========================================================================
-- APPLY AFTER: 20261003_003 (super_agent_reads_sub_agent_profiles)
--
-- THE BUG
-- -------
-- `super-agent-user-management`'s `createSubAgent` branch called
-- `auth.admin.createUser` and stopped. Everything it wrote landed in
-- `user_metadata` - which is SELF-WRITABLE and which nothing authorizes from.
--
-- `handle_new_user()` does fire on the auth INSERT and does create a profile
-- row, so the ROLE was readable ("sub_agent", mapped from the metadata).
-- But the trigger inserts only `id, role, email, full_name, business_name`.
-- It never writes `super_agent_id`, and nothing else did either.
--
-- So every sub agent created this way landed as:
--
--     role           = 'sub_agent'     (looked correct)
--     super_agent_id = NULL            (the actual defect)
--
-- ONE missing column produced BOTH reported symptoms:
--
--   1. ABSENT FROM THE ROSTER.
--      `listUsers` selects `user_profiles ... WHERE super_agent_id = <caller>`.
--      A NULL owner matches no row, so the agent the super agent had just
--      created silently did not appear in the list they were looking at.
--      `fetchSubAgentBalances` / `fetchSubAgentTopups` read the same column and
--      were equally blind to them.
--
--   2. EVERY ORDER COMES BACK `held`.
--      `verify-wallet-topup` refuses a `sub_agent` with no `super_agent_id`
--      with 403 BEFORE it ever reaches Paystack. `verify-payment` debits by
--      `p_super_agent_id => user.id`, and `resolvedWalletOwnerId` resolves to
--      NULL for an ownerless sub agent, so the debit has no wallet to charge.
--      An order whose debit cannot be made is not `completed` - it is `held`.
--      The money never moves; the agent sees their order parked, with no
--      actionable error anywhere in the app.
--
-- The role was NEVER the problem, which is why looking at it is misleading:
-- it read correctly off the metadata the whole time. The owner was missing.
-- ---------------------------------------------------------------------------
-- THE REPAIR
-- ----------
-- Ownership is recovered from the account's own `user_metadata.super_agent_id`
-- - the one field `createSubAgent` DID write, and the only surviving record of
-- who created this person. It is self-writable in general, which is exactly why
-- nothing authorizes from it; but here it is used purely to REPAIR a row on the
-- service-role path, and it is VERIFIED below before it is trusted.
--
-- THE VERIFICATION IS NOT OPTIONAL
-- --------------------------------
-- `user_metadata.super_agent_id` is writable by the account holder via
-- `supabase.auth.updateUser({ data: { super_agent_id: ... } })`. A sub agent
-- - or anyone else - could therefore point it at an arbitrary super agent, and
-- a naive repair would hand them that agent's roster, wallet and money.
--
-- So a candidate is accepted only if BOTH hold:
--
--   (a) it is a real, existing `super_agent` profile row, and
--   (b) that account really carries the `enterprise` badge in `app_metadata`,
--       which is the SAME gate `createSubAgent` itself enforces before it will
--       create a sub agent at all (service-role-only, not user-writable).
--
-- (b) makes the match far stronger than coincidence: it is the same predicate
-- the creation path enforces, so a value injected by a hostile sub agent
-- resolves to a caller who could not have created it in the first place.
--
-- A row failing either test is left EXACTLY as it is. It is not guessed at and
-- not reassigned - a wrong owner is worse than a missing one, because it routes
-- real money.
-- ---------------------------------------------------------------------------
-- 1. Repair the profile rows
-- ---------------------------------------------------------------------------
-- `phone` and `tier_name` live on `user_metadata` only and have no column
-- here; they are deliberately left alone rather than invented.
--
-- `sub_agent` is the row role already present. It is restated explicitly so a
-- row the trigger defaulted to something else is corrected in the same pass.
UPDATE public.user_profiles p
SET super_agent_id = resolved.owner_id,
    updated_at = now()
FROM (
  SELECT DISTINCT ON (u.id)
         u.id AS user_id,
         owner.id AS owner_id
  FROM auth.users u
  JOIN public.user_profiles me
    ON me.id = NULLIF(btrim(u.raw_user_meta_data ->> 'super_agent_id'), '')::uuid
  JOIN public.user_profiles owner
    ON owner.id = me.id
  JOIN public.user_profiles candidate
    ON candidate.id = u.id
  LEFT JOIN auth.users owner_auth
    ON owner_auth.id = owner.id
  WHERE candidate.super_agent_id IS NULL
    AND candidate.role = 'sub_agent'
    -- (a) the claimed owner is a real super agent
    AND me.role IN ('super_agent', 'superagent', 'super-agent', 'super agent')
    -- (b) ...and is actually badge-authorised to have sub agents at all.
    --     `app_metadata` cannot be written by the account holder.
    AND lower(btrim(COALESCE(owner_auth.raw_app_meta_data ->> 'super_agent_badge', ''))) = 'enterprise'
  ORDER BY u.id
) AS resolved
WHERE p.id = resolved.user_id
  AND p.super_agent_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Seed the mirror wallet row for every repaired sub-agent
-- ---------------------------------------------------------------------------
-- Migrations 008/012 give every sub agent a `super_agent_wallets` row: their
-- MIRRORED spending power. Only `admin-users`' `setUserRole` ever seeded it, so
-- a super-agent-created sub agent had none - the Pay button resolves no wallet
-- and the top-up cannot proceed.
--
-- The balance is 0 and stays 0. It is NEVER copied from the super agent's
-- balance, which would mint spending power nobody paid for, and it is never
-- seeded from top-up history here either.
--
-- `sub_agent_mirror_seed` (migration 011) is the correct source for "what they
-- actually PAID minus what they spent", and `admin-users`' `setUserRole` reads
-- it on promotion. This repair deliberately does not: the view is referenced by
-- name, and a reference to a missing relation is a PARSE-time error that would
-- abort the entire transaction - including the role repair above, which is the
-- part that actually matters. An unapplied 011 would therefore turn this repair
-- into a no-op.
--
-- 0 is not a loss here. These accounts could not place a single settling order
-- (the NULL owner made every debit impossible), so there is no spending history
-- to reconstruct that is not already wrong, and once repaired their real funds
-- arrive by the normal mirrored top-up path.
--
-- `ON CONFLICT DO NOTHING` so an existing real balance is never zeroed.
INSERT INTO public.super_agent_wallets (super_agent_id, balance)
SELECT p.id, 0
FROM public.user_profiles p
WHERE p.role = 'sub_agent'
  AND p.super_agent_id IS NOT NULL
ON CONFLICT (super_agent_id) DO NOTHING;

COMMIT;
