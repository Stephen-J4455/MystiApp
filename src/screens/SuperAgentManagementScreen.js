import React, { useEffect, useMemo, useState } from "react";
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

export default function SuperAgentManagementScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [offers, setOffers] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selectedOfferId, setSelectedOfferId] = useState(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [migrationWarning, setMigrationWarning] = useState("");
  const [form, setForm] = useState({
    title: "",
    network: "MTN",
    dataValue: "",
    price: "",
    description: "",
  });
  const [subAgentForm, setSubAgentForm] = useState({
    fullName: "",
    email: "",
    phone: "",
    password: "",
    initialBalance: "",
  });
  const { showError, showSuccess } = useNotification();

  const agentNameMap = useMemo(
    () =>
      agents.reduce((acc, agent) => {
        acc[agent.id] =
          agent.user_metadata?.full_name ||
          agent.email?.split("@")[0] ||
          "Agent";
        return acc;
      }, {}),
    [agents],
  );

  const assignmentMap = useMemo(() => {
    return assignments.reduce((acc, assignment) => {
      const offerId = String(assignment.offer_id);
      if (!acc[offerId]) acc[offerId] = [];
      acc[offerId].push(assignment.agent_id);
      return acc;
    }, {});
  }, [assignments]);

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
      await Promise.all([
        fetchOffers(user.id),
        fetchAgents(user.id),
        fetchAssignments(user.id),
      ]);
    } catch (error) {
      console.error("Error loading super-agent data:", error);
      showError("Error", "Failed to load your offer management data.");
    } finally {
      setLoading(false);
    }
  };

  const fetchOffers = async (superAgentId) => {
    try {
      const { data, error } = await supabase
        .from("super_agent_offers")
        .select("*")
        .eq("super_agent_id", superAgentId)
        .order("created_at", { ascending: false });

      if (error) {
        if (
          error.code === "42P01" ||
          error.message?.toLowerCase().includes("does not exist") ||
          error.message?.toLowerCase().includes("relation")
        ) {
          setMigrationWarning(
            "The super-agent offers table has not been added to the database yet. Run the staged SQL migration before creating offers.",
          );
          setOffers([]);
          return;
        }
        throw error;
      }

      setMigrationWarning("");
      setOffers(data || []);
      if (data?.length && !selectedOfferId) {
        setSelectedOfferId(String(data[0].id));
      }
    } catch (error) {
      console.error("Error fetching super-agent offers:", error);
      showError("Error", "Unable to load your offers right now.");
    }
  };

  const fetchAgents = async (superAgentId) => {
    try {
      const { data, error } = await supabase.auth.admin.listUsers();
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
      if (assignedAgents.length > 0 && !selectedAgentId) {
        setSelectedAgentId(assignedAgents[0].id);
      }
    } catch (error) {
      console.error("Error fetching assigned agents:", error);
    }
  };

  const fetchAssignments = async (superAgentId) => {
    try {
      const { data, error } = await supabase
        .from("super_agent_assignments")
        .select("*")
        .eq("super_agent_id", superAgentId);

      if (error) {
        if (
          error.code === "42P01" ||
          error.message?.toLowerCase().includes("does not exist") ||
          error.message?.toLowerCase().includes("relation")
        ) {
          setAssignments([]);
          return;
        }
        throw error;
      }

      setAssignments(data || []);
    } catch (error) {
      console.error("Error fetching assignments:", error);
    }
  };

  const handleCreateOffer = async () => {
    if (!currentUser) return;

    const title = form.title.trim();
    const dataValue = form.dataValue.trim();
    const price = Number(form.price);

    if (!title || !dataValue || !price || price <= 0) {
      showError("Validation", "Add a valid title, data value, and price.");
      return;
    }

    try {
      setCreating(true);
      const { error } = await supabase.from("super_agent_offers").insert({
        super_agent_id: currentUser.id,
        title,
        network: form.network,
        data_value: dataValue,
        price,
        description: form.description.trim(),
        is_active: true,
      });

      if (error) {
        if (
          error.code === "42P01" ||
          error.message?.toLowerCase().includes("does not exist") ||
          error.message?.toLowerCase().includes("relation")
        ) {
          setMigrationWarning(
            "The super-agent offers table is missing. Apply the staged SQL migration to enable offer creation.",
          );
          showError(
            "Migration required",
            "Apply the super-agent SQL migration first.",
          );
          return;
        }
        throw error;
      }

      setForm({
        title: "",
        network: "MTN",
        dataValue: "",
        price: "",
        description: "",
      });
      await fetchOffers(currentUser.id);
      await fetchAssignments(currentUser.id);
      showSuccess("Offer created", "Your data offer has been saved.");
    } catch (error) {
      console.error("Error creating offer:", error);
      showError("Error", "Unable to create the offer right now.");
    } finally {
      setCreating(false);
    }
  };

  const handleAssignOffer = async () => {
    if (!currentUser || !selectedOfferId || !selectedAgentId) {
      showError("Selection required", "Choose an agent and an offer first.");
      return;
    }

    try {
      setAssigning(true);
      const { error } = await supabase.from("super_agent_assignments").insert({
        super_agent_id: currentUser.id,
        agent_id: selectedAgentId,
        offer_id: Number(selectedOfferId),
        is_active: true,
      });

      if (error) {
        if (
          error.code === "42P01" ||
          error.message?.toLowerCase().includes("does not exist") ||
          error.message?.toLowerCase().includes("relation")
        ) {
          setMigrationWarning(
            "The super-agent assignment table is missing. Apply the staged SQL migration to enable assignments.",
          );
          showError(
            "Migration required",
            "Apply the staged super-agent migration first.",
          );
          return;
        }

        if (error.code === "23505") {
          showError(
            "Already assigned",
            "This agent already has this offer assigned.",
          );
          return;
        }

        throw error;
      }

      await fetchAssignments(currentUser.id);
      showSuccess(
        "Assignment saved",
        "The selected offer is now assigned to the agent.",
      );
    } catch (error) {
      console.error("Error assigning offer:", error);
      showError("Error", "Unable to assign the offer right now.");
    } finally {
      setAssigning(false);
    }
  };

  const handleCreateSubAgent = async () => {
    if (!currentUser) return;

    const { fullName, email, phone, password, initialBalance } = subAgentForm;

    if (!fullName.trim() || !email.trim()) {
      showError("Validation", "Full name and email are required.");
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

      const { data: userData, error: userError } =
        await supabase.auth.admin.createUser({
          email: email.trim(),
          password: password.trim(),
          user_metadata: {
            full_name: fullName.trim(),
            phone: phone.trim() || null,
            role: "Agent",
            super_agent_id: currentUser.id,
          },
          email_confirm: true,
        });

      if (userError) throw userError;

      const { error: walletError } = await supabase
        .from("agent_wallet")
        .insert({
          agent_id: userData.user.id,
          balance,
        });

      if (walletError) {
        console.error("Error creating wallet for sub-agent:", walletError);
      }

      setSubAgentForm({
        fullName: "",
        email: "",
        phone: "",
        password: "",
        initialBalance: "",
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
        showError("Error", "Unable to create this sub-agent right now.");
      }
    } finally {
      setCreatingAgent(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading offer management...</Text>
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
        <Text style={styles.title}>Super Agent Offers</Text>
      </View>

      {migrationWarning ? (
        <View style={styles.warningBox}>
          <Ionicons name="alert-circle" size={18} color="#d97706" />
          <Text style={styles.warningText}>{migrationWarning}</Text>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Create Data Offer</Text>

          <TextInput
            placeholder="Offer title"
            value={form.title}
            onChangeText={(value) =>
              setForm((prev) => ({ ...prev, title: value }))
            }
            style={styles.input}
          />

          <View style={styles.inlineFields}>
            <View style={styles.halfField}>
              <Text style={styles.label}>Network</Text>
              <View style={styles.selectField}>
                {["MTN", "TELECEL", "AIRTELTIGO"].map((network) => (
                  <TouchableOpacity
                    key={network}
                    onPress={() => setForm((prev) => ({ ...prev, network }))}
                    style={[
                      styles.optionChip,
                      form.network === network && styles.optionChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        form.network === network && styles.optionChipTextActive,
                      ]}
                    >
                      {network}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>

          <View style={styles.inlineFields}>
            <TextInput
              placeholder="Data value (e.g. 1GB)"
              value={form.dataValue}
              onChangeText={(value) =>
                setForm((prev) => ({ ...prev, dataValue: value }))
              }
              style={[styles.input, styles.halfInput]}
            />
            <TextInput
              placeholder="Price (GHS)"
              keyboardType="decimal-pad"
              value={form.price}
              onChangeText={(value) =>
                setForm((prev) => ({ ...prev, price: value }))
              }
              style={[styles.input, styles.halfInput]}
            />
          </View>

          <TextInput
            placeholder="Description (optional)"
            value={form.description}
            onChangeText={(value) =>
              setForm((prev) => ({ ...prev, description: value }))
            }
            style={styles.input}
            multiline
          />

          <TouchableOpacity
            style={[styles.primaryButton, creating && styles.disabledButton]}
            onPress={handleCreateOffer}
            disabled={creating}
          >
            <Text style={styles.primaryButtonText}>
              {creating ? "Creating..." : "Create Offer"}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Create Sub-Agent</Text>

          <TextInput
            placeholder="Full name"
            value={subAgentForm.fullName}
            onChangeText={(value) =>
              setSubAgentForm((prev) => ({ ...prev, fullName: value }))
            }
            style={styles.input}
          />

          <TextInput
            placeholder="Email address"
            keyboardType="email-address"
            autoCapitalize="none"
            value={subAgentForm.email}
            onChangeText={(value) =>
              setSubAgentForm((prev) => ({ ...prev, email: value }))
            }
            style={styles.input}
          />

          <TextInput
            placeholder="Phone number"
            keyboardType="phone-pad"
            value={subAgentForm.phone}
            onChangeText={(value) =>
              setSubAgentForm((prev) => ({ ...prev, phone: value }))
            }
            style={styles.input}
          />

          <TextInput
            placeholder="Password"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={subAgentForm.password}
            onChangeText={(value) =>
              setSubAgentForm((prev) => ({ ...prev, password: value }))
            }
            style={styles.input}
          />

          <TextInput
            placeholder="Initial wallet balance (GHS)"
            keyboardType="decimal-pad"
            value={subAgentForm.initialBalance}
            onChangeText={(value) =>
              setSubAgentForm((prev) => ({ ...prev, initialBalance: value }))
            }
            style={styles.input}
          />

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
          <Text style={styles.sectionTitle}>Assign Offer to Agent</Text>

          {agents.length === 0 ? (
            <Text style={styles.emptyStateText}>
              No agents are assigned to you yet. Create or assign one from the
              admin panel.
            </Text>
          ) : (
            <>
              <Text style={styles.label}>Assigned agents</Text>
              <View style={styles.agentList}>
                {agents.map((agent) => {
                  const fullName =
                    agent.user_metadata?.full_name ||
                    agent.email?.split("@")[0] ||
                    "Agent";

                  return (
                    <TouchableOpacity
                      key={agent.id}
                      onPress={() => setSelectedAgentId(agent.id)}
                      style={[
                        styles.agentButton,
                        selectedAgentId === agent.id &&
                          styles.agentButtonSelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.agentButtonText,
                          selectedAgentId === agent.id &&
                            styles.agentButtonTextSelected,
                        ]}
                      >
                        {fullName}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          <Text style={styles.label}>Choose offer</Text>
          {offers.length === 0 ? (
            <Text style={styles.emptyStateText}>
              Your offer list is empty. Create an offer to start assigning it.
            </Text>
          ) : (
            <View style={styles.offerSelectionList}>
              {offers.map((offer) => {
                const assignedNames = (assignmentMap[String(offer.id)] || [])
                  .map((agentId) => agentNameMap[agentId])
                  .filter(Boolean);

                return (
                  <TouchableOpacity
                    key={offer.id}
                    onPress={() => setSelectedOfferId(String(offer.id))}
                    style={[
                      styles.offerCard,
                      selectedOfferId === String(offer.id) &&
                        styles.offerCardSelected,
                    ]}
                  >
                    <View style={styles.offerHeaderRow}>
                      <Text style={styles.offerTitle}>{offer.title}</Text>
                      <Text style={styles.offerPrice}>
                        GHS {Number(offer.price).toFixed(2)}
                      </Text>
                    </View>

                    <Text style={styles.offerMeta}>
                      {offer.network} • {offer.data_value}
                    </Text>
                    {offer.description ? (
                      <Text style={styles.offerDescription}>
                        {offer.description}
                      </Text>
                    ) : null}

                    <Text style={styles.assignmentSummary}>
                      {assignedNames.length > 0
                        ? `Assigned to: ${assignedNames.join(", ")}`
                        : "Not assigned yet"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <TouchableOpacity
            style={[styles.primaryButton, assigning && styles.disabledButton]}
            onPress={handleAssignOffer}
            disabled={assigning || !selectedOfferId || !selectedAgentId}
          >
            <Text style={styles.primaryButtonText}>
              {assigning ? "Assigning..." : "Assign Selected Offer"}
            </Text>
          </TouchableOpacity>
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
  inlineFields: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 10,
  },
  halfField: {
    flex: 1,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.secondary,
    marginBottom: 6,
  },
  selectField: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  optionChip: {
    backgroundColor: colors.light,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#dfe7e7",
  },
  optionChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  optionChipText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.primary,
  },
  optionChipTextActive: {
    color: colors.white,
  },
  halfInput: {
    flex: 1,
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
  warningBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff7ed",
    borderColor: "#fed7aa",
    borderWidth: 1,
    borderRadius: 12,
    marginHorizontal: 18,
    marginBottom: 12,
    padding: 12,
    gap: 8,
  },
  warningText: {
    flex: 1,
    color: "#9a5b00",
    fontSize: 13,
    lineHeight: 18,
  },
  agentList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 10,
  },
  agentButton: {
    backgroundColor: colors.light,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#dfe7e7",
  },
  agentButtonSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  agentButtonText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  agentButtonTextSelected: {
    color: colors.white,
  },
  offerSelectionList: {
    gap: 10,
    marginTop: 8,
  },
  offerCard: {
    backgroundColor: colors.light,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#dfe7e7",
    padding: 12,
  },
  offerCardSelected: {
    borderColor: colors.primary,
    backgroundColor: "#edf9f7",
  },
  offerHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  offerTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: colors.primary,
    flex: 1,
  },
  offerPrice: {
    fontSize: 14,
    fontWeight: "800",
    color: colors.secondary,
  },
  offerMeta: {
    fontSize: 12,
    color: colors.secondary,
    fontWeight: "600",
    marginBottom: 4,
  },
  offerDescription: {
    fontSize: 12,
    color: colors.primary,
    marginBottom: 4,
  },
  assignmentSummary: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: "600",
  },
  emptyStateText: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 18,
  },
});
