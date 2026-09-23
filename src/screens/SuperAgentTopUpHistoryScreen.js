import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import { getEdgeFunctionName } from "../lib/env";
import colors from "../components/theme";

const getStatusColor = (status) => {
  switch (String(status || "").toLowerCase()) {
    case "success":
    case "completed":
      return colors.success;
    case "pending":
      return colors.warning;
    default:
      return colors.danger;
  }
};

export default function SuperAgentTopUpHistoryScreen({ navigation }) {
  const { showError } = useNotification();
  const [topUps, setTopUps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadTopUps = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

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

        const functionName = getEdgeFunctionName("super-agent-user-management");
        let { data: topUpData, error: topUpError } =
          await supabase.functions.invoke(functionName, {
            body: { action: "listTopUps" },
          });

        if (topUpError && functionName !== "super-agent-user-management") {
          const fallback = await supabase.functions.invoke(
            "super-agent-user-management",
            { body: { action: "listTopUps" } },
          );
          topUpData = fallback.data;
          topUpError = fallback.error;
        }

        if (!topUpError) {
          setTopUps(
            (topUpData?.topUps || []).map((topUp) => ({
              ...topUp,
              businessName: topUp.business_name || "Sub-agent",
            })),
          );
          return;
        }

        // Older deployments do not have listTopUps yet. Fall back to the
        // existing user list and direct table query while they are updated.
        const { data: subAgentData, error: subAgentError } =
          await supabase.functions.invoke(functionName, {
            body: { action: "listUsers", superAgentId: user.id },
          });
        if (subAgentError) throw topUpError;

        const subAgents = subAgentData?.users || [];
        const subAgentIds = subAgents.map((subAgent) => subAgent.id);
        const namesById = new Map(
          subAgents.map((subAgent) => [
            subAgent.id,
            subAgent.user_metadata?.business_name ||
              subAgent.user_metadata?.full_name ||
              subAgent.email ||
              "Sub-agent",
          ]),
        );
        if (subAgentIds.length === 0) {
          setTopUps([]);
          return;
        }

        const { data, error } = await supabase
          .from("wallet_topups")
          .select("*")
          .in("agent_id", subAgentIds)
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw error;

        setTopUps(
          (data || []).map((topUp) => ({
            ...topUp,
            businessName: namesById.get(topUp.agent_id) || "Sub-agent",
          })),
        );
      } catch (error) {
        console.error("Error loading sub-agent top-up history:", error);
        showError("Error", "Failed to load sub-agent top-up history.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [navigation, showError],
  );

  useEffect(() => {
    loadTopUps();
  }, [loadTopUps]);

  const formatDate = (value) => {
    if (!value) return "N/A";
    return new Date(value).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Sub-agent top-ups</Text>
          <Text style={styles.subtitle}>
            {topUps.length} transaction{topUps.length === 1 ? "" : "s"}
          </Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading top-up history...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={
            topUps.length ? styles.content : styles.emptyContent
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadTopUps(true)}
            />
          }
        >
          {topUps.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="wallet-outline" size={56} color={colors.border} />
              <Text style={styles.emptyTitle}>No sub-agent top-ups yet</Text>
              <Text style={styles.emptyText}>
                Top-ups made by your assigned sub-agents will appear here.
              </Text>
            </View>
          ) : (
            topUps.map((topUp) => {
              const status = String(topUp.status || "pending");
              return (
                <View key={topUp.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={styles.identity}>
                      <Ionicons
                        name="business-outline"
                        size={22}
                        color={colors.primary}
                      />
                      <View>
                        <Text style={styles.businessName}>
                          {topUp.businessName}
                        </Text>
                        <Text style={styles.date}>
                          {formatDate(topUp.created_at)}
                        </Text>
                      </View>
                    </View>
                    <Text
                      style={[styles.status, { color: getStatusColor(status) }]}
                    >
                      {status.toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.details}>
                    <Text style={styles.amount}>
                      Ghc {Number(topUp.amount || 0).toFixed(2)}
                    </Text>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Reference</Text>
                      <Text style={styles.detailValue} numberOfLines={1}>
                        {topUp.reference || "N/A"}
                      </Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Transaction ID</Text>
                      <Text style={styles.detailValue} numberOfLines={1}>
                        {topUp.paystack_transaction_id || "N/A"}
                      </Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Payment</Text>
                      <Text style={styles.detailValue}>
                        {[topUp.channel, topUp.bank]
                          .filter(Boolean)
                          .join(" / ") || "N/A"}
                      </Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Paid at</Text>
                      <Text style={styles.detailValue}>
                        {formatDate(topUp.paid_at)}
                      </Text>
                    </View>
                    <View style={styles.splitDetails}>
                      <Text style={styles.splitTitle}>Split details</Text>
                      <Text style={styles.detailValue}>
                        Subaccount: {topUp.split_subaccount_code || "N/A"}
                      </Text>
                      <Text style={styles.detailValue}>
                        Charge:{" "}
                        {topUp.split_percentage_charge !== null &&
                        topUp.split_percentage_charge !== undefined
                          ? `${Number(topUp.split_percentage_charge).toFixed(2)}%`
                          : "N/A"}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.light },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light,
  },
  title: { color: colors.dark, fontSize: 20, fontWeight: "800" },
  subtitle: { color: colors.secondary, marginTop: 2, fontSize: 13 },
  content: { padding: 16, gap: 12 },
  emptyContent: { flexGrow: 1, padding: 24 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { marginTop: 12, color: colors.secondary },
  emptyTitle: {
    marginTop: 14,
    color: colors.dark,
    fontSize: 18,
    fontWeight: "700",
  },
  emptyText: {
    marginTop: 8,
    color: colors.secondary,
    textAlign: "center",
    lineHeight: 20,
  },
  card: {
    padding: 16,
    borderRadius: 10,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  identity: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  businessName: { color: colors.dark, fontSize: 16, fontWeight: "700" },
  date: { color: colors.secondary, fontSize: 12, marginTop: 3 },
  status: { fontSize: 12, fontWeight: "800" },
  details: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  amount: { color: colors.dark, fontSize: 18, fontWeight: "800" },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 8,
  },
  detailLabel: { color: colors.secondary, fontSize: 12 },
  detailValue: { color: colors.dark, fontSize: 12, flexShrink: 1 },
  splitDetails: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 5,
  },
  splitTitle: { color: colors.primary, fontSize: 13, fontWeight: "800" },
});
