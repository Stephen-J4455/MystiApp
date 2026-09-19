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
  const [form, setForm] = useState({
    fullName: "",
    businessName: "",
    email: "",
    phone: "",
    password: "",
    initialBalance: "",
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

  const handleCreateSubAgent = async () => {
    if (!currentUser) return;

    const { fullName, businessName, email, phone, password, initialBalance } =
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

      const { data: responseData, error: userError } =
        await supabase.functions.invoke(getEdgeFunctionName("super-agent-user-management"), {
          body: {
            action: "createSubAgent",
            userData: {
              email: email.trim(),
              password: password.trim(),
              full_name: fullName.trim(),
              business_name: businessName.trim(),
              phone: phone.trim() || null,
              initialBalance: balance,
            },
          },
        });

      if (userError) throw userError;

      if (responseData?.error) {
        throw new Error(responseData.error);
      }

      setForm({
        fullName: "",
        businessName: "",
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

          {agents.length === 0 ? (
            <Text style={styles.emptyStateText}>
              No sub-agents have been created for you yet.
            </Text>
          ) : (
            <View style={styles.agentList}>
              {agents.map((agent) => (
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
                </View>
              ))}
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
