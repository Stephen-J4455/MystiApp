import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import colors from "../components/theme";
import { getEdgeFunctionName } from "../lib/env";
import {
  updateSubAgentTier,
  fetchSuperAgentTiers,
  createSubAgent,
} from "../services/superAgentService";

const normalizeRole = (user) => {
  const role = (user?.user_metadata?.role || user?.app_metadata?.role || "")
    .toString()
    .trim();

  if (!role) return null;

  const normalized = role.toLowerCase();
  if (normalized === "admin") return "Admin";
  if (normalized === "superagent" || normalized === "super_agent")
    return "SuperAgent";
  if (normalized === "agent") return "Agent";

  return role;
};

export default function SuperAgentAgentsScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [agents, setAgents] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [savingTierAgentId, setSavingTierAgentId] = useState(null);
  const [form, setForm] = useState({
    fullName: "",
    businessName: "",
    email: "",
    phone: "",
    password: "",
    initialBalance: "",
    tierName: "",
  });
  const { showError, showSuccess } = useNotification();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        navigation.replace("Login");
        return;
      }

      if (!isSuperAgent(user)) {
        navigation.replace("Home");
        return;
      }

      setCurrentUser(user);
      await fetchAgents(user.id);
      await fetchTiers(user.id);
    } catch (error) {
      console.error("Error loading super-agent agents:", error);
      showError("Error", "Failed to load your sub-agent list.");
    } finally {
      setLoading(false);
    }
  };

  const fetchAgents = async (superAgentId) => {
    try {
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-user-management"),
        {
          body: {
            action: "listUsers",
            superAgentId,
          },
        },
      );

      if (error) throw error;

      const assignedAgents = (data?.users || []).filter((member) => {
        const role = normalizeRole(member);
        const assignedSuperAgentId =
          member.user_metadata?.super_agent_id ||
          member.user_metadata?.superAgentId ||
          null;
        return role === "Agent" && assignedSuperAgentId === superAgentId;
      });

      setAgents(assignedAgents);
    } catch (error) {
      console.error("Error fetching agents:", error);
      showError("Error", "Unable to load your sub-agent list right now.");
    }
  };

  const fetchTiers = async (superAgentId) => {
    try {
      const activeTiers = await fetchSuperAgentTiers(
        superAgentId || currentUser?.id,
      );
      setTiers(activeTiers);
    } catch (error) {
      console.error("Error fetching tiers:", error);
      setTiers([]);
    }
  };

  const handleChangeTier = async (agent, tierName) => {
    if (!currentUser || savingTierAgentId) return;

    const currentTier = agent?.user_metadata?.tier_name || "";
    if (currentTier === tierName) return;

    const agentLabel =
      agent?.user_metadata?.full_name || agent?.email || "This sub-agent";

    try {
      setSavingTierAgentId(agent.id);

      await updateSubAgentTier({
        superAgentId: currentUser.id,
        agentId: agent.id,
        tierName,
      });

      // Update local state immediately for instant feedback
      setAgents((prev) =>
        prev.map((a) =>
          a.id === agent.id
            ? {
                ...a,
                user_metadata: {
                  ...(a.user_metadata || {}),
                  tier_name: tierName || null,
                },
              }
            : a,
        ),
      );

      showSuccess(
        "Tier updated",
        tierName
          ? `${agentLabel} now sees your ${tierName} packages.`
          : `${agentLabel} now sees your General packages.`,
      );

      // Re-fetch in background to stay fully synchronized
      fetchAgents(currentUser.id).catch(() => {});
    } catch (error) {
      console.error("Error updating sub-agent tier:", error);
      showError(
        "Error",
        error?.message || "Unable to update this sub-agent's tier right now.",
      );
    } finally {
      setSavingTierAgentId(null);
    }
  };

  const handleCreateSubAgent = async () => {
    if (!currentUser) return;

    const { fullName, businessName, email, phone, password, initialBalance, tierName } =
      form;

    if (!fullName.trim() || !businessName.trim() || !email.trim()) {
      showError(
        "Validation",
        "Full name, business name, and email are required.",
      );
      return;
    }

    if (!email.includes("@")) {
      showError("Validation", "Please enter a valid email address.");
      return;
    }

    if (!password || password.trim().length < 6) {
      showError(
        "Validation",
        "Password is required and must be at least 6 characters.",
      );
      return;
    }

    const balance = Number(initialBalance || 0);
    if (Number.isNaN(balance) || balance < 0) {
      showError("Validation", "Please enter a valid initial balance.");
      return;
    }

    try {
      setCreatingAgent(true);

      await createSubAgent({
        superAgentId: currentUser.id,
        email: email.trim(),
        password: password.trim(),
        fullName: fullName.trim(),
        businessName: businessName.trim(),
        phone: phone.trim() || null,
        initialBalance: balance,
        tierName: tierName.trim() || null,
      });

      setForm({
        fullName: "",
        businessName: "",
        email: "",
        phone: "",
        password: "",
        initialBalance: "",
        tierName: "",
      });

      await fetchAgents(currentUser.id);
      showSuccess(
        "Sub-agent created",
        `${fullName.trim()} was created and assigned to you.`,
      );
    } catch (error) {
      console.error("Error creating sub-agent:", error);
      if (error.message?.includes("already registered")) {
        showError("Error", "An account with this email already exists.");
      } else {
        showError("Error", error?.message || "Unable to create this sub-agent right now.");
      }
    } finally {
      setCreatingAgent(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading sub-agents...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>Sub-Agents</Text>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Create Sub-Agent</Text>

          <Text style={styles.label}>Full Name</Text>
          <TextInput
            placeholder="Enter full name"
            value={form.fullName}
            onChangeText={(value) =>
              setForm((prev) => ({ ...prev, fullName: value }))
            }
            style={styles.input}
          />

          <Text style={styles.label}>Business Name</Text>
          <TextInput
            placeholder="Enter business name"
            value={form.businessName}
            onChangeText={(value) =>
              setForm((prev) => ({ ...prev, businessName: value }))
            }
            style={styles.input}
          />

          <Text style={styles.label}>Email Address</Text>
          <TextInput
            placeholder="Enter email address"
            keyboardType="email-address"
            autoCapitalize="none"
            value={form.email}
            onChangeText={(value) =>
              setForm((prev) => ({ ...prev, email: value }))
            }
            style={styles.input}
          />

          <Text style={styles.label}>Phone Number</Text>
          <TextInput
            placeholder="Enter phone number"
            keyboardType="phone-pad"
            value={form.phone}
            onChangeText={(value) =>
              setForm((prev) => ({ ...prev, phone: value }))
            }
            style={styles.input}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            placeholder="Enter login password"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={form.password}
            onChangeText={(value) =>
              setForm((prev) => ({ ...prev, password: value }))
            }
            style={styles.input}
          />

          <Text style={styles.label}>Initial Wallet Balance (GHS)</Text>
          <TextInput
            placeholder="0.00"
            keyboardType="decimal-pad"
            value={form.initialBalance}
            onChangeText={(value) =>
              setForm((prev) => ({ ...prev, initialBalance: value }))
            }
            style={styles.input}
          />

          <Text style={styles.label}>Tier Access</Text>
          <Text style={styles.fieldHint}>
            Sub-agents see the prices you set for their tier. General fills any
            bundle your tier does not cover.
          </Text>
          <View style={styles.tierChipRow}>
            <TouchableOpacity
              style={[styles.tierChip, !form.tierName && styles.tierChipActive]}
              onPress={() => setForm((prev) => ({ ...prev, tierName: "" }))}
            >
              <Text
                style={[
                  styles.tierChipText,
                  !form.tierName && styles.tierChipTextActive,
                ]}
              >
                General
              </Text>
            </TouchableOpacity>
            {tiers.map((tier) => (
              <TouchableOpacity
                key={`form-tier-${tier.id}`}
                style={[
                  styles.tierChip,
                  form.tierName === tier.name && styles.tierChipActive,
                ]}
                onPress={() =>
                  setForm((prev) => ({ ...prev, tierName: tier.name }))
                }
              >
                <Text
                  style={[
                    styles.tierChipText,
                    form.tierName === tier.name && styles.tierChipTextActive,
                  ]}
                >
                  {tier.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[
              styles.primaryButton,
              creatingAgent && styles.disabledButton,
            ]}
            onPress={handleCreateSubAgent}
            disabled={creatingAgent}
          >
            <Text style={styles.primaryButtonText}>
              {creatingAgent ? "Creating..." : "Create Sub-Agent"}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Assigned Agents</Text>

          {tiers.length === 0 ? (
            <Text style={styles.fieldHint}>
              Create a tier first (Super Agent → Manage Tiers) to give sub-agents
              tier pricing. They see your General packages until then.
            </Text>
          ) : null}

          {agents.length === 0 ? (
            <Text style={styles.emptyStateText}>
              No sub-agents have been created for you yet.
            </Text>
          ) : (
            <View style={styles.agentList}>
              {agents.map((agent) => {
                const agentTier = agent.user_metadata?.tier_name || "";

                return (
                  <View key={agent.id} style={styles.agentItem}>
                    <Text style={styles.agentName}>
                      {agent.user_metadata?.full_name ||
                        agent.email?.split("@")[0]}
                    </Text>
                    <Text style={styles.agentMeta}>
                      {agent.user_metadata?.business_name ||
                        "Business name not set"}
                    </Text>
                    <Text style={styles.agentMeta}>{agent.email}</Text>

                    <Text style={styles.agentTierLabel}>
                      {savingTierAgentId === agent.id
                        ? "Saving tier..."
                        : `Tier access: ${agentTier || "General"}`}
                    </Text>
                    <View style={styles.tierChipRow}>
                      <TouchableOpacity
                        style={[
                          styles.tierChip,
                          !agentTier && styles.tierChipActive,
                        ]}
                        onPress={() => handleChangeTier(agent, "")}
                        disabled={Boolean(savingTierAgentId)}
                      >
                        <Text
                          style={[
                            styles.tierChipText,
                            !agentTier && styles.tierChipTextActive,
                          ]}
                        >
                          General
                        </Text>
                      </TouchableOpacity>
                      {tiers.map((tier) => (
                        <TouchableOpacity
                          key={`agent-${agent.id}-tier-${tier.id}`}
                          style={[
                            styles.tierChip,
                            agentTier === tier.name && styles.tierChipActive,
                          ]}
                          onPress={() => handleChangeTier(agent, tier.name)}
                          disabled={Boolean(savingTierAgentId)}
                        >
                          <Text
                            style={[
                              styles.tierChipText,
                              agentTier === tier.name &&
                                styles.tierChipTextActive,
                            ]}
                          >
                            {tier.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.light,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: colors.primary,
    fontWeight: "600",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 8,
    gap: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.white,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.primary,
  },
  scroll: {
    flex: 1,
    paddingHorizontal: 18,
    paddingBottom: 28,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: 16,
    marginBottom: 18,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 12,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.primary,
    marginBottom: 14,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.secondary,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.light,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#dfe7e7",
    marginBottom: 12,
    color: colors.primary,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  disabledButton: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: colors.white,
    fontWeight: "800",
    fontSize: 15,
  },
  emptyStateText: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 18,
  },
  agentList: {
    gap: 10,
  },
  fieldHint: {
    color: colors.secondary,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 8,
  },
  tierChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  tierChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  tierChipActive: {
    backgroundColor: colors.primary,
  },
  tierChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.primary,
  },
  tierChipTextActive: {
    color: colors.white,
  },
  agentTierLabel: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 8,
  },
  agentItem: {
    backgroundColor: colors.light,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#dfe7e7",
  },
  agentName: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.primary,
  },
  agentMeta: {
    fontSize: 12,
    color: colors.secondary,
    marginTop: 4,
  },
});
