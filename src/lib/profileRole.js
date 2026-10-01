/**
 * Canonical role vocabulary, and the one place it is derived.
 *
 * WHY A DEDICATED MODULE
 * ----------------------
 * The role is stored as snake_case text (`user_profiles.role`), while the UI
 * has always spoken in PascalCase (`"SuperAgent"`, `"NormalUser"`). That
 * translation used to live in three separate files - `lib/superAgent.js`,
 * `App.js` and an inline copy in `SuperAgentAgentsScreen.js` - and they had
 * already drifted apart, which is how a normal user ended up with a wallet
 * card in front of them.
 *
 * This module is a PURE function of the profile row. It imports nothing, so it
 * can be unit-tested directly and reused from a context, a screen, or a plain
 * function with no React involved.
 *
 * THE STORE IS NOT NEGOTIABLE
 * --------------------------
 * `public.user_profiles` is the only authoritative source. `user_metadata` is
 * writable by the account owner via `supabase.auth.updateUser()`, so a role
 * read from there is self-assignable, and `app_metadata` - although not
 * user-writable - lives inside the ACCESS TOKEN, which supabase-js caches for
 * up to an hour. A role change is therefore invisible in the token for an hour
 * after an admin makes it, while `user_profiles` updated in the same
 * transaction is live immediately. Every edge function reads the table
 * (`resolveIdentity`); the client must read the same row or the two disagree.
 */

/** The only four role values the UI is ever allowed to see. */
export const CANONICAL_ROLES = Object.freeze({
  ADMIN: "Admin",
  SUPER_AGENT: "SuperAgent",
  SUB_AGENT: "Agent",
  NORMAL_USER: "NormalUser",
});

/**
 * Fold a raw `user_profiles.role` string into a canonical role.
 *
 * A MISSING or unreadable role resolves to `"NormalUser"`, which is the
 * least-privileged reading and the correct one: a profile we could not read
 * must not render a wallet balance or a management screen. Returning `null`
 * instead would force every caller to invent its own default, and they had
 * consistently invented the wrong one.
 *
 * An UNRECOGNISED role also folds to `"NormalUser"`. A new role must be added
 * here before it unlocks anything, which is the correct direction for a
 * permission change to fail in.
 *
 * @param {{role?: string|null}|null|undefined} profile a `user_profiles` row
 * @returns {"Admin"|"SuperAgent"|"Agent"|"NormalUser"}
 */
export function profileRole(profile) {
  const raw = String(profile?.role || "")
    .trim()
    .toLowerCase();
  if (!raw) return CANONICAL_ROLES.NORMAL_USER;
  if (raw === "admin" || raw === "administrator") return CANONICAL_ROLES.ADMIN;
  if (raw === "super_agent" || raw === "superagent")
    return CANONICAL_ROLES.SUPER_AGENT;
  // `agent` is the legacy spelling written by the original signup trigger and
  // by the pre-20260926_005 demotion path. Both mean a sub-agent.
  if (raw === "sub_agent" || raw === "subagent" || raw === "agent")
    return CANONICAL_ROLES.SUB_AGENT;
  if (raw === "normal_user" || raw === "normaluser" || raw === "user")
    return CANONICAL_ROLES.NORMAL_USER;
  return CANONICAL_ROLES.NORMAL_USER;
}

/**
 * Does this account have a Super Agent to fund?
 *
 * A SUB-AGENT is a row holder exactly like a super agent - migrations 008 and
 * 012 give every sub-agent their own `super_agent_wallets` row, which is their
 * MIRRORED spending power, not a former super agent's leftover. So "has a
 * wallet" must never be inferred from ownership, and "is a sub-agent" must
 * never be inferred from the absence of one.
 *
 * The owner requirement is deliberately NOT part of this. It is enforced where
 * the money actually moves: `verify-wallet-topup` refuses with 403 BEFORE it
 * touches Paystack when a sub-agent has no `super_agent_id`, so an ownerless
 * sub-agent reaching the Pay button gets an actionable error instead of a
 * permanently disabled one.
 */
export function isSubAgentWithOwner(profile) {
  return (
    profileRole(profile) === CANONICAL_ROLES.SUB_AGENT &&
    Boolean(String(profile?.superAgentId || ""))
  );
}

/**
 * The account's own wallet row ownership.
 *
 * `super_agent_wallets` is keyed on `super_agent_id` with RLS
 * `super_agent_id = auth.uid()` and NO role term, so holding a row is a
 * property of the DATA and survives a demotion. Gating on the role instead is
 * what made a demoted account's real balance look like it had vanished.
 */
export function retainsWalletRow(userId, walletRow) {
  if (!userId || !walletRow) return false;
  // Accepts either shape: `ProfileContext` normalises to `superAgentId`, while
  // a raw PostgREST row is snake_case.
  const owner = walletRow.superAgentId || walletRow.super_agent_id;
  if (!owner) return false;
  return String(owner) === String(userId);
}
