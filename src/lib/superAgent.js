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
  if (normalized === "user" || normalized === "normal_user")
    return "NormalUser";
  if (normalized === "normaluser") return "NormalUser";

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

/**
 * The raw role key as the AUTH RECORD holds it, or "" when there is none.
 *
 * `app_metadata` is consulted first: it is the service-role-only store, so an
 * account owner cannot forge a role into it via `auth.updateUser()`.
 * `user_metadata` second, and only because pre-`20260928_001` accounts still
 * carry their role there and nowhere else.
 */
function authRoleKey(user) {
  return String(user?.app_metadata?.role || user?.user_metadata?.role || "")
    .trim()
    .toLowerCase();
}

/**
 * The account's role, treating a MISSING role as "Normal User".
 *
 * WHY THIS EXISTS
 * ---------------
 * "No role key in either metadata store" IS the canonical representation of a
 * normal user. `admin-users.setUserRole` DELETES `user_metadata.role` and
 * `app_metadata.role` when demoting to normal_user rather than writing the
 * string, and `handle_new_user()` (migration 20260928_002) stamps
 * `user_profiles.role = 'normal_user'` for a signup that carried no role. So
 * the most common normal user in the system stores NO role at all.
 *
 * `normalizeRole` must keep returning `null` for an absent role - it is a pure
 * fold of a value that may genuinely not be there, and several callers use the
 * `null` to mean "could not determine". Folding absence into `NormalUser` there
 * would silently convert an unresolved read into a permission decision.
 *
 * This wrapper is the place that MAY make that inference, because a caller
 * asking "what is this account's role" is asking a question that has a
 * default answer.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Every wallet gate keyed on `userRole === "NormalUser"`. For a normal user
 * carrying no role key that was `null`, so the check was false, the gate
 * failed OPEN, and the wallet card rendered. `HomeScreen` had the same shape
 * via `isNormalUser`, which never became true. The gates were correct in
 * intent and wrong in the only case that matters, because the very accounts
 * they were written to protect are the ones that store no role.
 *
 * WHY AN UNRECOGNISED ROLE ALSO BECOMES "NormalUser"
 * --------------------------------------------------
 * `normalizeRole` returns anything it does not recognise VERBATIM, which is
 * right for it (it is a pure fold, and a caller may want to display the raw
 * value). Propagating that here would make an unknown role - `quantum_agent`,
 * or any value written by a newer admin build - compare false against
 * `=== "NormalUser"` and therefore sail through the wallet veto, which is
 * precisely the fail-open this function exists to remove.
 *
 * So the only roles that may reach a gate are the four the system actually
 * defines. Anything else is not a grant, and the safe reading of "I do not
 * recognise this role" is the least-privileged one. A role added later needs
 * a matching arm here before it can unlock anything, which is the correct
 * direction for a permission change to fail in.
 */
export function accountRole(user) {
  const normalized = normalizeRole(authRoleKey(user));
  // Absent, or an explicit normal_user: the two spellings of the same account
  // type, one of which stores nothing at all.
  if (!normalized || normalized === "NormalUser") return "NormalUser";
  // A recognised, non-normal role. Only these four are ever returned, so
  // `=== "NormalUser"` is a real veto rather than a comparison against a value
  // that merely happens not to be spelled that way.
  if (
    normalized === "Admin" ||
    normalized === "SuperAgent" ||
    normalized === "Agent"
  ) {
    return normalized;
  }
  // Unrecognised. Fail closed, deliberately - see the note above.
  return "NormalUser";
}

export function isNormalUser(user) {
  return accountRole(user) === "NormalUser";
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
