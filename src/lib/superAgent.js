export const DEFAULT_SUPER_AGENT_SPLIT = {
  adminShareRate: 0.3,
  superAgentShareRate: 0.2,
  agentNetRate: 0.5,
};

/**
 * Role and ownership predicates.
 *
 * EVERY predicate in this file takes a `user_profiles` row (or the
 * `ProfileContext` value that wraps one), NOT an auth user. The role used to
 * come out of `user_metadata` / `app_metadata`:
 *
 *   * `user_metadata` is writable by the account owner through
 *     `supabase.auth.updateUser()`, so a role read from it is self-assignable.
 *   * `app_metadata` is not user-writable, but it lives inside the ACCESS
 *     TOKEN, which supabase-js caches for up to an hour - so an admin's role
 *     change was invisible to a running app for up to an hour.
 *
 * `public.user_profiles` is the store every edge function authorizes from
 * (`resolveIdentity`), it is RLS-protected, and it is on the realtime
 * publication. Reading it here is what keeps the client and the server from
 * disagreeing about who somebody is.
 *
 * The role FOLD itself lives in `lib/profileRole.js` so the context, the
 * screens and the tests all share one implementation.
 */
import { profileRole, retainsWalletRow } from "./profileRole";

export function calculateSettlement(grossAmount, overrides = {}) {
  const gross = Number(grossAmount || 0);
  const adminShareRate = Number(
    overrides.adminShareRate ?? DEFAULT_SUPER_AGENT_SPLIT.adminShareRate,
  );
  const superAgentShareRate = Number(
    overrides.superAgentShareRate ??
      DEFAULT_SUPER_AGENT_SPLIT.superAgentShareRate,
  );

  const adminShare = Number((gross * adminShareRate).toFixed(2));
  const superAgentShare = Number((gross * superAgentShareRate).toFixed(2));
  const agentNet = Number((gross - adminShare - superAgentShare).toFixed(2));

  return {
    grossAmount: Number(gross.toFixed(2)),
    adminShare,
    superAgentShare,
    agentNet,
    adminShareRate: adminShareRate,
    superAgentShareRate: superAgentShareRate,
    agentNetRate: Number((1 - adminShareRate - superAgentShareRate).toFixed(4)),
  };
}

export function isAdmin(profile) {
  return profileRole(profile) === "Admin";
}

export function isNormalUser(profile) {
  return profileRole(profile) === "NormalUser";
}

export function isSuperAgent(profile) {
  return profileRole(profile) === "SuperAgent";
}

/**
 * True when this account STILL OWNS A WALLET, even if it is no longer a Super
 * Agent.
 *
 * WHY THIS EXISTS
 * ---------------
 * Demoting a Super Agent to sub_agent (or normal user) must not silently
 * destroy money they earned. Nothing in the schema deletes a wallet row on a
 * role change, and `super_agent_wallets` RLS is `super_agent_id = auth.uid()`
 * with NO role term - so the balance and ledger remain readable. What changes
 * is that every super-agent screen bounces them to Home, so the balance
 * becomes invisible even though it is intact.
 *
 * The owning Super Agent is a property of the WALLET ROW, not of the role, so
 * the correct test is "is there a wallet with my id?" - not "do I hold the
 * super agent role?".
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * This is deliberately a visibility predicate, not a permission grant. Every
 * ability that MOVES money stays gated on the role:
 *   * `verify-payment` refuses the wallet path unless
 *     `identity.role === "super_agent"`, because that path debits by
 *     `p_super_agent_id => user.id`.
 *   * `paystack-subaccount` requires the role AND the Enterprise badge.
 *   * the Enterprise-only management actions stay badge-gated.
 * A deranked account can therefore see its balance and history, and can do
 * nothing at all with it.
 *
 * @param {string|null} userId
 * @param {object|null} walletRow a row from `super_agent_wallets`, or null
 */
export function retainsWallet(userId, walletRow) {
  return retainsWalletRow(userId, walletRow);
}

export function isAgent(profile) {
  return profileRole(profile) === "Agent";
}

/**
 * The `super_agent_id` a record reports as its owner.
 *
 * Read from the `user_profiles`-derived shape (`superAgentId`, or the raw
 * snake_case `super_agent_id` a PostgREST row carries). NOT from auth metadata:
 * `user_metadata.super_agent_id` is writable by the account owner via
 * `auth.updateUser()`, so a metadata leg here would let any user nominate
 * their own supervisor and see - or act on - another agent's subordinates.
 */
const ownerIdOf = (record) => {
  if (!record) return null;
  const value =
    record.superAgentId || record.super_agent_id || record.superAgentID || null;
  return value ? String(value) : null;
};

export function canViewAssignedAgent(currentProfile, targetProfile) {
  if (!currentProfile || !targetProfile) return false;

  if (isAdmin(currentProfile)) return true;

  if (!isSuperAgent(currentProfile)) return false;

  return ownerIdOf(targetProfile) === String(currentProfile.id);
}

export function filterAssignedAgents(currentProfile, agents = []) {
  if (!currentProfile) return [];

  if (isAdmin(currentProfile)) return agents;
  if (!isSuperAgent(currentProfile)) return [];

  return agents.filter(
    (agent) => ownerIdOf(agent) === String(currentProfile.id),
  );
}
