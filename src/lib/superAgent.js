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
  if (normalized === "agent") return "Agent";

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
  const targetSuperAgentId = targetUser?.user_metadata?.super_agent_id || null;

  return targetSuperAgentId === currentUserId;
}

export function filterAssignedAgents(currentUser, agents = []) {
  if (!currentUser) return [];

  if (isAdmin(currentUser)) return agents;
  if (!isSuperAgent(currentUser)) return [];

  return agents.filter((agent) => {
    const superAgentId = agent?.user_metadata?.super_agent_id || null;
    return superAgentId === currentUser.id;
  });
}
