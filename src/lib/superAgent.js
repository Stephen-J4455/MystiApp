export const DEFAULT_SUPER_AGENT_SPLIT = {
  adminShareRate: 0.3,
  superAgentShareRate: 0.2,
  agentNetRate: 0.5,
};

export function normalizeRole(role) {
  if (!role) return null;

  const value = String(role).trim();
  if (!value) return null;

  const normalized = value.toLowerCase();
  if (normalized === "admin") return "Admin";
  if (normalized === "superagent" || normalized === "super_agent")
    return "SuperAgent";
  if (normalized === "agent" || normalized === "sub_agent") return "Agent";

  return value;
}

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

export function isAdmin(user) {
  return (
    normalizeRole(user?.user_metadata?.role || user?.app_metadata?.role) ===
    "Admin"
  );
}

export function isSuperAgent(user) {
  return (
    normalizeRole(user?.user_metadata?.role || user?.app_metadata?.role) ===
    "SuperAgent"
  );
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
 * @param {object|null} user
 * @param {object|null} walletRow a row from `super_agent_wallets`, or null
 */
export function retainsWallet(user, walletRow) {
  if (!user?.id || !walletRow) return false;
  return String(walletRow.super_agent_id || "") === String(user.id);
}

export function isAgent(user) {
  return (
    normalizeRole(user?.user_metadata?.role || user?.app_metadata?.role) ===
    "Agent"
  );
}

export function canViewAssignedAgent(currentUser, targetUser) {
  if (!currentUser || !targetUser) return false;

  if (isAdmin(currentUser)) return true;

  if (!isSuperAgent(currentUser)) return false;

  const currentUserId = currentUser.id;
  const targetSuperAgentId =
    targetUser?.user_metadata?.super_agent_id ||
    targetUser?.user_metadata?.superAgentId ||
    targetUser?.app_metadata?.super_agent_id ||
    targetUser?.app_metadata?.superAgentId ||
    null;

  return targetSuperAgentId === currentUserId;
}

export function filterAssignedAgents(currentUser, agents = []) {
  if (!currentUser) return [];

  if (isAdmin(currentUser)) return agents;
  if (!isSuperAgent(currentUser)) return [];

  return agents.filter((agent) => {
    const superAgentId =
      agent?.user_metadata?.super_agent_id ||
      agent?.user_metadata?.superAgentId ||
      agent?.app_metadata?.super_agent_id ||
      agent?.app_metadata?.superAgentId ||
      null;
    return superAgentId === currentUser.id;
  });
}
