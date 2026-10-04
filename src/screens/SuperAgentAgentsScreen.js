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
import { useProfile } from "../contexts/ProfileContext";
import { profileRole } from "../lib/profileRole";
import { sanitizeGhanaPhone } from "../lib/ghanaPhone";
import { useThemedStyles } from "../components/ui";
import { fonts } from "../components/theme";
import { getEdgeFunctionName } from "../lib/env";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import {
  updateSubAgentTier,
  fetchSuperAgentTiers,
  createSubAgent,
} from "../services/superAgentService";
import { fetchSubAgentBalances } from "../lib/superAgentRoster";

export default function SuperAgentAgentsScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [agents, setAgents] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [savingTierAgentId, setSavingTierAgentId] = useState(null);
  // Whether the create form is expanded. Seeded from the roster, not default
  // true, so the common case - a super agent who already has sub-agents -
  // opens on their list rather than on an empty form. A super agent with NO
  // sub-agents still gets the form immediately, because that is the only
  // thing there is to do on the screen.
  const [showCreateForm, setShowCreateForm] = useState(false);
  // Mirrored wallet balance per sub-agent id. Read through
  // `fetchSubAgentBalances`, which returns the ROSTER alongside each balance
  // rather than a bare map, so a sub-agent with no wallet row still appears -
  // at zero, meaning "never funded" rather than "missing".
  const [walletBalances, setWalletBalances] = useState({});
  // The sub-agent whose tier menu is open, or null. Keyed on id rather than a
  // boolean so a second card cannot open its menu mid-save.
  const [tierMenuForId, setTierMenuForId] = useState(null);
  const [form, setForm] = useState({
    fullName: "",
    businessName: "",
    email: "",
    phone: "",
    password: "",
    tierName: "",
  });
  const { showError, showSuccess } = useNotification();
  const { isSuperAgent, profile } = useProfile();
  const { c } = useThemedStyles();
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useAgentsStyles(c, topInset);
  // Single source for the badge gate. It was previously read inline at two
  // separate render sites, so the header button and the form could disagree
  // about whether this account may create sub-agents - and `handleCreateSubAgent`
  // checked it a third time. All three now read one value.
  //
  // Read from `app_metadata` ONLY. `user_metadata.super_agent_badge` is
  // writable by the account owner via `auth.updateUser()`, so a Pro account
  // could rewrite it to "enterprise" and unlock sub-agent creation for
  // itself.
  const hasEnterpriseBadge =
    String(
      currentUser?.app_metadata?.super_agent_badge || "enterprise",
    ).toLowerCase() === "enterprise";
  // The bottom dock is absolutely positioned on native, so it floats over the
  // scroll view. Adds its height plus the safe-area inset so the trailing
  // create button is never stranded underneath. Web returns just `extra`.
  const dockBottomPadding = useDockBottomPadding(28);

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

      if (!isSuperAgent) {
        navigation.replace("Home");
        return;
      }

      setCurrentUser(user);
      await fetchAgents(user.id);
            await Promise.all([fetchTiers(user.id), fetchWalletBalances(user.id)]);
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

      // `role` and `superAgentId` come from `user_profiles`, resolved
      // server-side and attached to each member by `listUsers`. The previous
      // filter read `member.user_metadata.super_agent_id`, which the LISTED
      // account can rewrite at will via `auth.updateUser()` - so a sub-agent
      // could point that key at a different Super Agent and appear in someone
      // else's roster.
      const assignedAgents = (data?.users || []).filter(
        (member) =>
          profileRole({ role: member.role }) === "Agent" &&
          String(member.superAgentId || "") === String(superAgentId),
      );

      setAgents(assignedAgents);
            // Seeded once the roster is known, and deliberately NOT on every fetch:
            // `fetchAgents` also runs after a tier change and after a successful
            // create, so re-seeding here would slam the form shut under a super
            // agent who is midway through typing the next sub-agent.
            setShowCreateForm((prev) => prev || assignedAgents.length === 0);
          } catch (error) {
            console.error("Error fetching agents:", error);
      showError("Error", "Unable to load your sub-agent list right now.");
    }
  };

  // Each sub-agent's MIRRORED spending ceiling, not their real money. Read
  // separately from `fetchAgents` because that path resolves the roster from
  // `auth.admin` and carries no wallet data; `super_agent_wallets` is keyed on
  // the HOLDER, so the balances are one row per sub-agent and cannot be a
  // single query on this super agent's id.
  //
  // Per-source failure is caught rather than thrown: a denied read of
  // `super_agent_wallets` returns `[]` rather than an error, and it must not
  // blank the agent list beside it. The cards fall back to no balance figure
  // rather than showing a false zero.
  const fetchWalletBalances = async (superAgentId) => {
    try {
      const roster = (await fetchSubAgentBalances({
        superAgentId: superAgentId || currentUser?.id,
      })) || [];
      setWalletBalances(
        Object.fromEntries(
          roster.map((member) => [String(member.id), Number(member.balance || 0)]),
        ),
      );
    } catch (error) {
      console.error("Error loading sub-agent wallet balances:", error);
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
      currentUser.app_metadata?.super_agent_badge || "enterprise",
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

      // Collapse AFTER the roster reload, so the new sub-agent is visible
            // before the form disappears. Left open it would bury the row the
            // super agent just created behind a fresh, empty form.
            setShowCreateForm(false);

            await fetchAgents(currentUser.id);
            // A newly created sub-agent is funded at zero (migration 20260928_008
            // section 3), so the balance map must be re-read or their card would
            // show the "unknown" dash instead of a real Ghc 0.00 until the screen
            // was reloaded.
            await fetchWalletBalances(currentUser.id);
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
        <Text style={[styles.title, styles.titleFlex]}>Sub-Agents</Text>
                {/* The create entry point now lives in the header, and is only
                    rendered when the account can actually use it. A Pro-badge
                    super agent is shown the locked card below instead, so giving
                    them a button that always errors would be a worse version of
                    the badge check the card already states. */}
                {hasEnterpriseBadge && !showCreateForm ? (
                  <TouchableOpacity
                    style={styles.addButton}
                    onPress={() => setShowCreateForm(true)}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel="Add a new sub-agent"
                  >
                    <Ionicons name="add" size={20} color={c.mint} />
                    <Text style={styles.addButtonText}>New Agent</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

      <KeyboardAwareScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: dockBottomPadding }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {!hasEnterpriseBadge ? (
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
                ) : showCreateForm ? (
                  <View style={styles.card}>
                    <View style={styles.cardHeaderRow}>
                      <Text style={styles.sectionTitle}>Create Sub-Agent</Text>
                      {/* Dismissal. Only offered once a sub-agent exists - with an
                          empty roster there is nothing behind this form, so hiding it
                          would leave the screen blank. */}
                      {agents.length > 0 ? (
                        <TouchableOpacity
                          style={styles.cardHeaderClose}
                          onPress={() => setShowCreateForm(false)}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                          accessibilityLabel="Close the create sub-agent form"
                        >
                          <Ionicons name="close" size={17} color={c.textMuted} />
                        </TouchableOpacity>
                      ) : null}
                    </View>

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
                  ) : null}

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
                // Absent from the map means the wallet read failed or has not
                // landed yet. Rendering that as `Ghc 0.00` would state a
                // balance nobody has verified, so it shows a dash instead.
                const balanceKnown = Object.prototype.hasOwnProperty.call(
                  walletBalances,
                  String(agent.id),
                );
                const balance = balanceKnown
                  ? walletBalances[String(agent.id)]
                  : 0;

                return (
                  <View key={agent.id} style={styles.agentItem}>
                                      {/* Identity on the left, mirrored balance on the right. The
                                          balance is this sub-agent's spending CEILING - money
                                          the super agent has already funded - not money they
                                          have paid out, so it is labelled as a balance rather
                                          than as earnings or sales. */}
                                      <View style={styles.agentTopRow}>
                                        <View style={styles.agentAvatar}>
                                          <Text style={styles.agentAvatarText}>
                                            {(agent.user_metadata?.full_name ||
                                              agent.email ||
                                              "?")
                                              .trim()
                                              .charAt(0)
                                              .toUpperCase()}
                                          </Text>
                                        </View>
                                        <View style={styles.agentIdentity}>
                                          <Text style={styles.agentName} numberOfLines={1}>
                                            {agent.user_metadata?.full_name ||
                                              agent.email?.split("@")[0]}
                                          </Text>
                                          <Text style={styles.agentMeta} numberOfLines={1}>
                                            {agent.user_metadata?.business_name ||
                                              "Business name not set"}
                                          </Text>
                                          <Text style={styles.agentMeta} numberOfLines={1}>
                                            {agent.email}
                                          </Text>
                                        </View>
                                        <View style={styles.agentBalanceBox}>
                                          <Text style={styles.agentBalanceLabel}>Balance</Text>
                                          <Text style={styles.agentBalanceValue}>
                                            {balanceKnown
                                              ? `Ghc ${balance.toFixed(2)}`
                                              : "—"}
                                          </Text>
                                        </View>
                                      </View>

                                      {/* Tier selection moved into a popup menu. Inline chips
                                          repeated the full tier list once per sub-agent, so a
                                          roster of ten with five tiers rendered fifty tappable
                                          rows and pushed every card's real content off screen. */}
                                      <TouchableOpacity
                                        style={styles.tierSelectRow}
                                        onPress={() =>
                                          setTierMenuForId(
                                            tierMenuForId === agent.id ? null : agent.id,
                                          )
                                        }
                                        activeOpacity={0.85}
                                        disabled={Boolean(savingTierAgentId)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Tier access for ${
                                          agent.user_metadata?.full_name || "sub-agent"
                                        }`}
                                        accessibilityState={{ expanded: tierMenuForId === agent.id }}
                                      >
                                        <View style={styles.tierSelectIcon}>
                                          <Ionicons name="layers-outline" size={16} color={c.mintDim} />
                                        </View>
                                        <View style={styles.tierSelectCopy}>
                                          <Text style={styles.tierSelectLabel}>Tier access</Text>
                                          <Text style={styles.tierSelectValue}>
                                            {savingTierAgentId === agent.id
                                              ? "Saving..."
                                              : agentTier || "General"}
                                          </Text>
                                        </View>
                                        <Ionicons
                                          name={
                                            tierMenuForId === agent.id ? "chevron-up" : "chevron-down"
                                          }
                                          size={18}
                                          color={c.textMuted}
                                        />
                                      </TouchableOpacity>

                                      {tierMenuForId === agent.id ? (
                                        <View style={styles.tierMenu}>
                                          <TouchableOpacity
                                            style={[
                                              styles.tierMenuItem,
                                              !agentTier && styles.tierMenuItemActive,
                                            ]}
                                            onPress={() => {
                                              setTierMenuForId(null);
                                              handleChangeTier(agent, "");
                                            }}
                                            disabled={Boolean(savingTierAgentId)}
                                          >
                                            <Text
                                              style={[
                                                styles.tierMenuItemText,
                                                !agentTier && styles.tierMenuItemTextActive,
                                              ]}
                                            >
                                              General
                                            </Text>
                                            <Text style={styles.tierMenuItemHint}>
                                              All of your packages
                                            </Text>
                                          </TouchableOpacity>
                                          {tiers.map((tier) => (
                                            <TouchableOpacity
                                              key={`menu-agent-${agent.id}-tier-${tier.id}`}
                                              style={[
                                                styles.tierMenuItem,
                                                agentTier === tier.name &&
                                                  styles.tierMenuItemActive,
                                              ]}
                                              onPress={() => {
                                                setTierMenuForId(null);
                                                handleChangeTier(agent, tier.name);
                                              }}
                                              disabled={Boolean(savingTierAgentId)}
                                            >
                                              <Text
                                                style={[
                                                  styles.tierMenuItemText,
                                                  agentTier === tier.name &&
                                                    styles.tierMenuItemTextActive,
                                                ]}
                                              >
                                                {tier.name}
                                              </Text>
                                              <Text style={styles.tierMenuItemHint}>
                                                Your {tier.name} packages
                                              </Text>
                                            </TouchableOpacity>
                                          ))}
                                        </View>
                                      ) : null}
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
        // Header row holds three children - back, title, action - so the title
        // takes the slack and the action is pinned right. Without `flex: 1` on
        // the title the action would sit immediately after the text rather than
        // at the trailing edge.
        titleFlex: {
          flex: 1,
        },
        addButton: {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: 13,
          paddingVertical: 9,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: c.hairlineStrong,
          backgroundColor: c.surface,
        },
        addButtonText: {
          fontFamily: fonts.bodySemi,
          fontSize: 12.5,
          color: c.mint,
        },
        cardHeaderRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        },
        cardHeaderClose: {
          width: 30,
          height: 30,
          borderRadius: 11,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c.surfaceHover,
        },
    scroll: {
      flex: 1,
      paddingHorizontal: 18,
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
    agentItem: {
      backgroundColor: c.canvasRaised,
      borderRadius: 16,
          padding: 13,
      borderWidth: 1,
      borderColor: c.hairline,
          gap: 10,
        },
        // Identity row. `agentIdentity` takes the slack so the balance column is
        // pinned right and cannot be pushed off by a long business name - which is
        // why the name, business and email all carry `numberOfLines={1}`.
        agentTopRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 11,
        },
        agentAvatar: {
          width: 40,
          height: 40,
          borderRadius: 14,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c.surfaceHover,
        },
        agentAvatarText: {
          fontFamily: fonts.bodyBold,
          fontSize: 16,
          color: c.mint,
        },
        agentIdentity: {
          flex: 1,
        },
        agentBalanceBox: {
          alignItems: "flex-end",
        },
        agentBalanceLabel: {
          fontFamily: fonts.body,
          fontSize: 10,
          color: c.textMuted,
        },
        agentBalanceValue: {
          fontFamily: fonts.bodyBold,
          fontSize: 15,
          color: c.textPrimary,
          marginTop: 2,
        },
        tierSelectRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 9,
          paddingHorizontal: 11,
          borderRadius: 14,
          backgroundColor: c.surface,
          borderWidth: 1,
          borderColor: c.hairline,
        },
        tierSelectIcon: {
          width: 28,
          height: 28,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c.surfaceHover,
        },
        tierSelectCopy: {
          flex: 1,
        },
        tierSelectLabel: {
          fontFamily: fonts.body,
          fontSize: 10.5,
          color: c.textMuted,
        },
        tierSelectValue: {
          fontFamily: fonts.bodySemi,
          fontSize: 13.5,
          color: c.textPrimary,
          marginTop: 1,
        },
        tierMenu: {
          borderRadius: 14,
          borderWidth: 1,
          borderColor: c.hairline,
          backgroundColor: c.surface,
          overflow: "hidden",
        },
        tierMenuItem: {
          paddingVertical: 10,
          paddingHorizontal: 12,
        },
        tierMenuItemActive: {
          backgroundColor: c.surfaceHover,
        },
        tierMenuItemText: {
          fontFamily: fonts.bodySemi,
          fontSize: 13.5,
          color: c.textPrimary,
        },
        tierMenuItemTextActive: {
          color: c.mint,
        },
        tierMenuItemHint: {
          fontFamily: fonts.body,
          fontSize: 11,
          color: c.textMuted,
          marginTop: 2,
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
