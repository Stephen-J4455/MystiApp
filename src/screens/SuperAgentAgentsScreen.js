import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Platform,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import { sanitizeGhanaPhone } from "../lib/ghanaPhone";
import { useThemedStyles } from "../components/ui";
import { fonts } from "../components/theme";
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
  if (normalized === "agent" || normalized === "sub_agent") return "Agent";

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
    tierName: "",
  });
  const { showError, showSuccess } = useNotification();
  const { c } = useThemedStyles();
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useAgentsStyles(c, topInset);

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
          member.app_metadata?.super_agent_id ||
          member.app_metadata?.superAgentId ||
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
    const badge = String(
      currentUser.user_metadata?.super_agent_badge ||
        currentUser.app_metadata?.super_agent_badge ||
        "enterprise",
    ).toLowerCase();
    if (badge !== "enterprise") {
      showError(
        "Pro access",
        "Creating sub-agents requires the Enterprise badge.",
      );
      return;
    }

    const { fullName, businessName, email, phone, password, tierName } = form;

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

    try {
      setCreatingAgent(true);

      await createSubAgent({
        superAgentId: currentUser.id,
        email: email.trim(),
        password: password.trim(),
        fullName: fullName.trim(),
        businessName: businessName.trim(),
        phone: phone.trim() || null,
        tierName: tierName.trim() || null,
      });

      setForm({
        fullName: "",
        businessName: "",
        email: "",
        phone: "",
        password: "",
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
        showError(
          "Error",
          error?.message || "Unable to create this sub-agent right now.",
        );
      }
    } finally {
      setCreatingAgent(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={c.mint} />
          <Text style={styles.loadingText}>Loading sub-agents...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color={c.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Sub-Agents</Text>
      </View>

      <KeyboardAwareScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {String(
          currentUser?.user_metadata?.super_agent_badge ||
            currentUser?.app_metadata?.super_agent_badge ||
            "enterprise",
        ).toLowerCase() !== "enterprise" ? (
          <View style={styles.card}>
            <View style={styles.restrictedIcon}>
              <Ionicons name="lock-closed" size={28} color={c.amber} />
            </View>
            <Text style={styles.restrictedTitle}>
              Enterprise badge required
            </Text>
            <Text style={styles.restrictedText}>
              The Pro badge does not include creating sub-agents. Contact an
              administrator to upgrade this account.
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Create Sub-Agent</Text>

            <Text style={styles.label}>Full Name</Text>
            <TextInput
              placeholder="Enter full name"
              placeholderTextColor={c.textMuted}
              value={form.fullName}
              onChangeText={(value) =>
                setForm((prev) => ({ ...prev, fullName: value }))
              }
              style={styles.input}
            />

            <Text style={styles.label}>Business Name</Text>
            <TextInput
              placeholder="Enter business name"
              placeholderTextColor={c.textMuted}
              value={form.businessName}
              onChangeText={(value) =>
                setForm((prev) => ({ ...prev, businessName: value }))
              }
              style={styles.input}
            />

            <Text style={styles.label}>Email Address</Text>
            <TextInput
              placeholder="Enter email address"
              placeholderTextColor={c.textMuted}
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
              placeholderTextColor={c.textMuted}
              keyboardType="phone-pad"
              maxLength={10}
              value={form.phone}
              onChangeText={(value) =>
                setForm((prev) => ({
                  ...prev,
                  phone: sanitizeGhanaPhone(value),
                }))
              }
              style={styles.input}
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              placeholder="Enter login password"
              placeholderTextColor={c.textMuted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              value={form.password}
              onChangeText={(value) =>
                setForm((prev) => ({ ...prev, password: value }))
              }
              style={styles.input}
            />

            <Text style={styles.label}>Tier Access</Text>
            <Text style={styles.fieldHint}>
              Sub-agents see the prices you set for their tier. General fills
              any bundle your tier does not cover.
            </Text>
            <View style={styles.tierChipRow}>
              <TouchableOpacity
                style={[
                  styles.tierChip,
                  !form.tierName && styles.tierChipActive,
                ]}
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
        )}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Assigned Agents</Text>

          {tiers.length === 0 ? (
            <Text style={styles.fieldHint}>
              Create a tier first (Super Agent → Manage Tiers) to give
              sub-agents tier pricing. They see your General packages until
              then.
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
      </KeyboardAwareScrollView>
    </View>
  );
}

// The stylesheet is a factory over the palette: `c` is the light or dark token
// set, rebuilt only when the scheme flips.
const useAgentsStyles = (c, topInset = 0) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.canvas,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: c.canvas,
    },
    loadingText: {
      marginTop: 12,
      fontFamily: fonts.bodySemi,
      fontSize: 15,
      color: c.mint,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 18,
      paddingTop: 18 + topInset,
      paddingBottom: 8,
      gap: 12,
    },
    backButton: {
      width: 40,
      height: 40,
      borderRadius: 13,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
      justifyContent: "center",
      alignItems: "center",
    },
    title: {
      fontFamily: fonts.display,
      fontSize: 24,
      color: c.textPrimary,
    },
    scroll: {
      flex: 1,
      paddingHorizontal: 18,
      paddingBottom: 28,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 16,
      marginBottom: 18,
    },
    sectionTitle: {
      fontFamily: fonts.display,
      fontSize: 18,
      color: c.textPrimary,
      marginBottom: 14,
    },
    label: {
      fontFamily: fonts.bodySemi,
      fontSize: 11.5,
      color: c.textSecondary,
      marginBottom: 7,
    },
    input: {
      backgroundColor: c.canvasRaised,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 13,
      borderWidth: 1,
      borderColor: c.hairline,
      marginBottom: 12,
      fontFamily: fonts.body,
      fontSize: 15,
      color: c.textPrimary,
    },
    primaryButton: {
      backgroundColor: c.mint,
      borderRadius: 999,
      paddingVertical: 15,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 8,
    },
    disabledButton: {
      opacity: 0.55,
    },
    restrictedIcon: {
      alignSelf: "center",
      width: 58,
      height: 58,
      borderRadius: 20,
      backgroundColor: c.surfaceHover,
      borderWidth: 1,
      borderColor: c.hairline,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 14,
    },
    restrictedTitle: {
      color: c.textPrimary,
      fontFamily: fonts.display,
      fontSize: 18,
      textAlign: "center",
    },
    restrictedText: {
      color: c.textMuted,
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 19,
      textAlign: "center",
      marginTop: 7,
    },
    primaryButtonText: {
      color: c.onAccent,
      fontFamily: fonts.bodyBold,
      fontSize: 15,
    },
    emptyStateText: {
      color: c.textMuted,
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 19,
    },
    agentList: {
      gap: 10,
    },
    fieldHint: {
      color: c.textMuted,
      fontFamily: fonts.body,
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
      borderRadius: 999,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
    },
    tierChipActive: {
      backgroundColor: c.mint,
      borderColor: c.mint,
    },
    tierChipText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.textSecondary,
    },
    tierChipTextActive: {
      color: c.onAccent,
    },
    agentTierLabel: {
      color: c.mint,
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      marginTop: 8,
    },
    agentItem: {
      backgroundColor: c.canvasRaised,
      borderRadius: 16,
      padding: 12,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    agentName: {
      fontFamily: fonts.bodySemi,
      fontSize: 15,
      color: c.textPrimary,
    },
    agentMeta: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 4,
    },
    agentBalance: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.textPrimary,
      marginTop: 8,
    },
  });
