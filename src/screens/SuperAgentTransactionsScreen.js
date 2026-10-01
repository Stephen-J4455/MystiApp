import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
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
import { useProfile } from "../contexts/ProfileContext";
import {
  isHeldWindowElapsed,
  isReorderableHeldOrder,
  reorderHeldOrder,
} from "../lib/heldOrderReorder";
import colors from "../components/theme";
import { ThemedScreen } from "../components/ui";

export default function SuperAgentTransactionsScreen({ navigation }) {
  const { showError, showSuccess } = useNotification();
  const { isSuperAgent } = useProfile();
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState([]);
  // Id of the held order being retried, or null. One id rather than a boolean so
  // a second row cannot be tapped mid-flight.
  const [reorderingId, setReorderingId] = useState(null);

  const loadTransactions = useCallback(async () => {
    try {
      const {
        data: { user },
        error: e,
      } = await supabase.auth.getUser();
      if (e || !user) {
        navigation.replace("Login");
        return;
      }
      if (!isSuperAgent) {
        navigation.replace("Home");
        return;
      }
      const { data: s } = await supabase
        .from("super_agent_paystack")
        .select("subaccount_code")
        .eq("super_agent_id", user.id)
        .maybeSingle();
      {
        const c = s?.subaccount_code;
        const { data: tu, error: e1 } = await supabase
          .from("wallet_topups")
          .select("*")
          .eq("agent_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100);
        const { data: od, error: e2 } = await supabase
          .from("payment_transactions")
          .select("*")
          .eq("super_agent_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100);

        // Held orders live on `agent_orders`, not on either of the two
        // settlement tables above - which is precisely why this screen could
        // never show one. A super agent whose wallet had run dry saw their
        // sub-agents' orders vanish from every surface at once, with nothing to
        // retry them from. Fetched separately rather than through a union so a
        // failure here cannot take the ledger rows down with it.
        const heldResult = await supabase
          .from("agent_orders")
          .select("*")
          .eq("super_agent_id", user.id)
          .eq("status", "held")
          .order("created_at", { ascending: false })
          .limit(100);
        if (heldResult.error) {
          console.error("Failed to load held orders:", heldResult.error);
        }

        if (e1 || e2) throw e1 || e2;
        const a = [];
        (tu || []).forEach((t) =>
          a.push({
            ...t,
            source: "wallet_topup",
            amountDisplay: "Ghc " + Number(t.amount || 0).toFixed(2),
            statusColor:
              t.status === "success"
                ? colors.success
                : t.status === "pending"
                  ? colors.warning
                  : colors.danger,
          }),
        );
        (od || []).forEach((o) =>
          a.push({
            ...o,
            source: "data_purchase",
            amountDisplay: "Ghc " + Number(o.gross_amount || 0).toFixed(2),
            statusColor:
              o.status === "completed"
                ? colors.success
                : o.status === "pending"
                  ? colors.warning
                  : colors.danger,
          }),
        );
        // Marked so the shared `isReorderableHeldOrder` test accepts the row:
        // it rejects `orderType: "regular"`, and absence means agent_orders.
        (heldResult.data || []).forEach((h) =>
          a.push({
            ...h,
            orderType: "agent",
            source: "held_order",
            amountDisplay:
              "Ghc " + Number(h.base_amount || h.amount || 0).toFixed(2),
            statusColor: colors.warning,
          }),
        );
        a.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
        setTransactions(a);
      }
    } catch (err) {
      console.error(err);
      showError("Error", "Failed to load transactions.");
    } finally {
      setLoading(false);
    }
  }, [navigation, showError]);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  // Retries a held order. The window check, the invoke and the error unwrapping
  // live in lib/heldOrderReorder.js so this screen, Home, the Receipt and
  // History cannot drift. Re-reads the list on success so the row's status
  // updates.
  const handleReorder = async (row) => {
    setReorderingId(row.id);
    try {
      const result = await reorderHeldOrder(row);
      if (!result.ok) {
        showError("Reorder Failed", result.message);
        return;
      }
      showSuccess(
        "Order Reordered",
        "The held order was sent to the provider.",
      );
      loadTransactions();
    } finally {
      setReorderingId(null);
    }
  };

  const fmt = (d) => {
    try {
      return new Date(d).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return d;
    }
  };

  if (loading)
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </SafeAreaView>
    );

  return (
    <ThemedScreen style={styles.safeArea}>
      <SafeAreaView style={styles.safeArea} edges={["top"]}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backButton}
          >
            <Ionicons name="arrow-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.title}>Transactions</Text>
            <Text style={styles.subtitle}>
              {transactions.length} transaction
              {transactions.length !== 1 ? "s" : ""} found
            </Text>
          </View>
        </View>
        {transactions.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="receipt-outline" size={64} color={colors.border} />
            <Text style={styles.emptyTitle}>No Transactions Yet</Text>
            <Text style={styles.emptyText}>
              Transactions routed through your Paystack sub-account will appear
              here.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            {transactions.map((tx, i) => {
              // Held orders are the only rows here that can be retried, and the
              // retry is only valid inside the 24h window.
              const showReorder = isReorderableHeldOrder(tx);
              const reorderElapsed = showReorder
                ? isHeldWindowElapsed(tx, Date.now())
                : false;
              const reorderBusy = reorderingId === tx.id;
              const typeLabel =
                tx.source === "wallet_topup"
                  ? "Wallet Top-up"
                  : tx.source === "held_order"
                    ? "Held Order"
                    : "Data Purchase";
              const icon =
                tx.source === "wallet_topup"
                  ? "wallet"
                  : tx.source === "held_order"
                    ? "alert-circle"
                    : "phone-portrait";

              return (
                <View key={i} style={styles.txCard}>
                  <View style={styles.txHeader}>
                    <View style={styles.txIconWrap}>
                      <Ionicons name={icon} size={22} color={colors.primary} />
                    </View>
                    <View style={styles.txMeta}>
                      <Text style={styles.txType}>{typeLabel}</Text>
                      <Text style={styles.txDate}>{fmt(tx.created_at)}</Text>
                    </View>
                    <View
                      style={[
                        styles.txStatus,
                        { backgroundColor: tx.statusColor },
                      ]}
                    >
                      <Text style={styles.txStatusText}>
                        {String(
                          tx.jehuca_order_status || tx.status || "unknown",
                        ).toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.txBody}>
                    <View style={styles.txInfoRow}>
                      <Text style={styles.txInfoLabel}>Reference</Text>
                      <Text style={styles.txInfoValue} numberOfLines={1}>
                        {tx.reference || tx.id?.toString().slice(0, 12)}
                      </Text>
                    </View>
                    <View style={styles.txInfoRow}>
                      <Text style={styles.txInfoLabel}>Amount</Text>
                      <Text style={styles.txInfoValueBold}>
                        {tx.amountDisplay}
                      </Text>
                    </View>
                    {tx.paystack_transaction_id && (
                      <View style={styles.txInfoRow}>
                        <Text style={styles.txInfoLabel}>Paystack TX ID</Text>
                        <Text style={styles.txInfoValue} numberOfLines={1}>
                          {tx.paystack_transaction_id}
                        </Text>
                      </View>
                    )}
                    {tx.channel && (
                      <View style={styles.txInfoRow}>
                        <Text style={styles.txInfoLabel}>Channel</Text>
                        <Text style={styles.txInfoValue}>{tx.channel}</Text>
                      </View>
                    )}
                    {tx.source === "data_purchase" && (
                      <>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Sub-agent</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.agent_id || "N/A"}
                          </Text>
                        </View>
                        {/* `payment_transactions.recipient_phone` is written by
                            verify-payment for every row, but this card never
                            showed it, so a super agent could not see who they
                            bought data for without opening each transaction. */}
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Recipient</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.recipient_phone || "N/A"}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Base share</Text>
                          <Text style={styles.txInfoValue}>
                            Ghc {Number(tx.base_amount || 0).toFixed(2)}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>
                            Transaction fee
                          </Text>
                          <Text style={styles.txInfoValue}>
                            Ghc {Number(tx.transaction_fee || 0).toFixed(2)}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Your share</Text>
                          <Text style={styles.txInfoValue}>
                            Ghc {Number(tx.super_agent_amount || 0).toFixed(2)}
                          </Text>
                        </View>
                        {tx.jehuca_order_id && (
                          <View style={styles.txInfoRow}>
                            <Text style={styles.txInfoLabel}>Jehuca order</Text>
                            <Text style={styles.txInfoValue}>
                              {tx.jehuca_order_id}
                            </Text>
                          </View>
                        )}
                      </>
                    )}
                    {tx.source === "held_order" && (
                      <>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Recipient</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.recipient_phone || "N/A"}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Network</Text>
                          <Text style={styles.txInfoValue}>
                            {String(tx.network || "N/A").toUpperCase()}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Package</Text>
                          <Text style={styles.txInfoValue} numberOfLines={1}>
                            {tx.offer_title || "N/A"}
                          </Text>
                        </View>
                        {tx.payment_reference && (
                          <View style={styles.txInfoRow}>
                            <Text style={styles.txInfoLabel}>Reference</Text>
                            <Text style={styles.txInfoValue} numberOfLines={1}>
                              {tx.payment_reference}
                            </Text>
                          </View>
                        )}
                      </>
                    )}

                    {/* Retry. A held order means the customer PAID and our
                      internal wallet debit failed, so this is the only thing
                      that moves the order forward - and it is only valid
                      inside the 24h window. */}
                    {showReorder ? (
                      <TouchableOpacity
                        style={[
                          styles.reorderButton,
                          reorderElapsed && styles.reorderButtonClosed,
                        ]}
                        onPress={() => handleReorder(tx)}
                        disabled={reorderBusy || reorderElapsed}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityLabel={
                          reorderElapsed
                            ? "Reorder window closed"
                            : "Reorder this held order"
                        }
                      >
                        {reorderBusy ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.white}
                          />
                        ) : (
                          <Ionicons
                            name="refresh"
                            size={17}
                            color={
                              reorderElapsed ? colors.border : colors.white
                            }
                          />
                        )}
                        <Text
                          style={[
                            styles.reorderText,
                            reorderElapsed && styles.reorderTextClosed,
                          ]}
                        >
                          {reorderElapsed
                            ? "Reorder window closed"
                            : reorderBusy
                              ? "Reordering…"
                              : "Reorder this order"}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
      </SafeAreaView>
    </ThemedScreen>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.light },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.light,
  },
  loadingText: {
    marginTop: 12,
    color: colors.dark,
    fontSize: 16,
    fontWeight: "600",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 12,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  headerCenter: { flex: 1 },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.dark },
  subtitle: { fontSize: 12, color: colors.border, marginTop: 2 },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
    gap: 12,
  },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: colors.dark },
  emptyText: {
    fontSize: 14,
    color: colors.border,
    textAlign: "center",
    lineHeight: 22,
  },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  txCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  txHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  txIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  txMeta: { flex: 1 },
  txType: { fontSize: 14, fontWeight: "700", color: colors.dark },
  txDate: { fontSize: 12, color: colors.border, marginTop: 2 },
  txStatus: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  txStatusText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fff",
    textTransform: "uppercase",
  },
  txBody: { borderTopWidth: 1, borderTopColor: colors.light, paddingTop: 10 },
  txInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 3,
  },
  txInfoLabel: { fontSize: 12, color: colors.border },
  txInfoValue: {
    fontSize: 12,
    color: colors.dark,
    fontWeight: "500",
    flex: 1,
    textAlign: "right",
  },
  txInfoValueBold: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: "700",
    flex: 1,
    textAlign: "right",
  },

  // ---------- Reorder (held orders) ----------
  reorderButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  reorderButtonClosed: { backgroundColor: colors.light },
  reorderText: { fontSize: 14, fontWeight: "700", color: colors.white },
  reorderTextClosed: { color: colors.border },
});
