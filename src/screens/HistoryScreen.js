import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Animated,
  StatusBar,
  Platform,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { isSuperAgent } from "../lib/superAgent";
import { removeChannelSafe, uniqueTopic } from "../lib/realtime";
import { getEdgeFunctionName } from "../lib/env";
import { getEdgeFunctionErrorMessage } from "../lib/edgeFunctions";
import { useNotification } from "../contexts/NotificationContext";
import { useTheme } from "../contexts/ThemeContext";
import { EmptyState } from "../components/ui";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import { fonts } from "../components/theme";

const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

const refreshProviderStatuses = async (orders) => {
  const results = await Promise.all(
    (orders || []).map(async (order) => {
      if (!order.jehuca_order_id) return order;

      try {
        const { data, error } = await supabase.functions.invoke(
          getEdgeFunctionName("check-order-status"),
          { body: { orderId: order.jehuca_order_id } },
        );
        if (error) {
          if (
            getEdgeFunctionName("check-order-status") !== "check-order-status"
          ) {
            const fallback = await supabase.functions.invoke(
              "check-order-status",
              { body: { orderId: order.jehuca_order_id } },
            );
            if (!fallback.error) {
              return {
                ...order,
                jehuca_order_status:
                  fallback.data?.data?.status || order.jehuca_order_status,
              };
            }
          }
          return order;
        }
        if (data?.success === false) {
          console.warn(
            "Jehucal status request failed:",
            data.error,
            data.providerStatusCode,
          );
          return order;
        }

        const providerStatus =
          data?.data?.status ||
          data?.payload?.status ||
          data?.order?.status ||
          data?.status;
        if (!providerStatus) return order;

        if (providerStatus !== order.jehuca_order_status) {
          await supabase
            .from("agent_orders")
            .update({ jehuca_order_status: providerStatus })
            .eq("id", order.id);
        }

        return { ...order, jehuca_order_status: providerStatus };
      } catch (error) {
        console.warn("Unable to refresh Jehuca status:", error);
        return order;
      }
    }),
  );

  return results;
};

export default function HistoryScreen({ navigation }) {
  const { c, isDark, statusTone: tones } = useTheme();
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const s = useHistoryStyles(c, topInset);
  // Clears the floating bottom dock so the last order row stays reachable.
  const dockPadding = useDockBottomPadding(12);

  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isAgent, setIsAgent] = useState(false);
  const [isSuperAgentUser, setIsSuperAgentUser] = useState(false);
  const [reorderingId, setReorderingId] = useState(null);
  const { showError, showSuccess } = useNotification();
  const skeletonOpacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    checkAgentStatus();

    // Add listener to refresh when returning to screen
    const unsubscribe = navigation.addListener("focus", () => {
      // Re-check agent status and fetch transactions when returning to screen
      checkAgentStatus(true);
    });

    return unsubscribe;
  }, [navigation]);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(skeletonOpacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(skeletonOpacity, {
          toValue: 0.6,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [skeletonOpacity]);

  // Real-time updates for orders
  useEffect(() => {
    let historyChannel = null;
    let cancelled = false;

    const setupRealtimeSubscriptions = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        const isAssignedSuperAgent = isSuperAgent(user);
        const channel = supabase.channel(uniqueTopic("history_orders_realtime"));

        // Register every callback before subscribing. Supabase Realtime does
        // not allow adding postgres_changes callbacks after subscribe().
        channel.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "orders",
            filter: `user_id=eq.${user.id}`,
          },
          () => checkAgentStatus(true),
        );

        channel.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "agent_orders",
            filter: `agent_id=eq.${user.id}`,
          },
          () => checkAgentStatus(true),
        );

        if (isAssignedSuperAgent) {
          channel.on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "agent_orders",
              filter: `super_agent_id=eq.${user.id}`,
            },
            () => checkAgentStatus(true),
          );
        }

        historyChannel = channel;
        channel.subscribe();
      } catch (error) {
        console.error("Error setting up orders realtime subscriptions:", error);
      }
    };

    setupRealtimeSubscriptions();

    return () => {
      cancelled = true;
      // `historyChannel` may still be null if the effect was cleaned up during
      // the awaits above; the channel is then leaked and the next mount
      // collides with it. `removeChannelSafe` also no-ops on null.
      removeChannelSafe(historyChannel);
      historyChannel = null;
    };
  }, []);

  const checkAgentStatus = async (isRefresh = false) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const superAgentStatus = isSuperAgent(user);
        setIsSuperAgentUser(superAgentStatus);
        const normalizedRole = String(
          user.user_metadata?.role || user.app_metadata?.role || "",
        ).toLowerCase();
        const agentStatus =
          normalizedRole === "agent" ||
          normalizedRole === "sub_agent" ||
          Boolean(
            user.user_metadata?.super_agent_id ||
            user.user_metadata?.superAgentId,
          );
        setIsAgent(agentStatus);

        // Fetch transactions after determining agent status
        fetchTransactions(agentStatus, isRefresh);
      }
    } catch (error) {
      console.error("Error checking agent status:", error);
      setIsAgent(false);
      fetchTransactions(false, isRefresh);
    }
  };

  const fetchTransactions = async (
    agentStatus = isAgent,
    isRefresh = false,
  ) => {
    try {
      if (!isRefresh) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        let allTransactions = [];

        // Fetch regular orders
        const { data: regularOrders, error: regularError } = await supabase
          .from("orders")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });

        if (regularError) {
          console.error("Error fetching regular orders:", regularError);
        } else {
          const normalizedRegularOrders = (regularOrders || []).map(
            (order) => ({
              ...order,
              orderType: "regular",
              displayName: order.user_name,
              displayPhone: order.phone,
            }),
          );
          allTransactions = [...allTransactions, ...normalizedRegularOrders];
        }

        // If user is an agent, fetch agent orders too
        if (agentStatus) {
          const { data: agentOrders, error: agentError } = await supabase
            .from("agent_orders")
            .select("*")
            .eq("agent_id", user.id)
            .order("created_at", { ascending: false });

          if (agentError) {
            console.error("Error fetching agent orders:", agentError);
          } else {
            const refreshedAgentOrders =
              await refreshProviderStatuses(agentOrders);
            const normalizedAgentOrders = refreshedAgentOrders.map((order) => ({
              ...order,
              orderType: "agent",
              displayName: order.recipient_name,
              displayPhone: order.recipient_phone,
            }));
            allTransactions = [...allTransactions, ...normalizedAgentOrders];
          }
        }

        if (isSuperAgent(user)) {
          const { data: assignedOrders, error: assignedError } = await supabase
            .from("agent_orders")
            .select("*")
            .eq("super_agent_id", user.id)
            .order("created_at", { ascending: false });

          if (assignedError) {
            console.error("Error fetching sub-agent orders:", assignedError);
          } else {
            const refreshedAssignedOrders =
              await refreshProviderStatuses(assignedOrders);
            const subAgentFunctionName = getEdgeFunctionName(
              "super-agent-user-management",
            );
            let subAgentResult = await supabase.functions.invoke(
              subAgentFunctionName,
              { body: { action: "listUsers", superAgentId: user.id } },
            );
            if (
              subAgentResult.error &&
              subAgentFunctionName !== "super-agent-user-management"
            ) {
              subAgentResult = await supabase.functions.invoke(
                "super-agent-user-management",
                { body: { action: "listUsers", superAgentId: user.id } },
              );
            }
            const subAgentData = subAgentResult.data;
            const subAgentError = subAgentResult.error;
            if (subAgentError) {
              console.error("Error fetching sub-agent names:", subAgentError);
            }
            const subAgentBusinessNames = new Map(
              (subAgentData?.users || []).map((subAgent) => [
                subAgent.id,
                subAgent.user_metadata?.business_name || "",
              ]),
            );
            const assignedTransactions = refreshedAssignedOrders.map(
              (order) => ({
                ...order,
                orderType: "agent",
                isSubAgentTransaction: true,
                subAgentBusinessName:
                  subAgentBusinessNames.get(order.agent_id) || "",
                displayName: order.recipient_name,
                displayPhone: order.recipient_phone,
              }),
            );
            allTransactions = [...allTransactions, ...assignedTransactions];
          }
        }

        // Sort all transactions by created_at
        allTransactions.sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at),
        );

        setTransactions(allTransactions);
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    checkAgentStatus(true);
  };

  const reorderHeldOrder = async (order) => {
    setReorderingId(order.id);
    try {
      const reorderFunctionName = getEdgeFunctionName(
        "reorder-held-agent-order",
      );
      const { data, error } = await supabase.functions.invoke(
        reorderFunctionName,
        { body: { order_id: order.id } },
      );
      if (error || !data?.success) {
        const message = await getEdgeFunctionErrorMessage(
          error,
          data?.error || "Could not reorder held order.",
        );
        throw new Error(message);
      }
      showSuccess("Order Reordered", "The package was sent to Jehucal.");
      await checkAgentStatus(true);
    } catch (error) {
      console.error("Held order reorder failed:", error);
      showError("Reorder Failed", error.message || "Could not reorder order.");
    } finally {
      setReorderingId(null);
    }
  };

  // Status presentation now comes from the shared tone map, which is
  // scheme-aware - the old hardcoded hexes were tuned for white cards only.
  // "held" (super agent orders awaiting reorder) has no entry in the shared
  // map, so it borrows the pending treatment and keeps its own label.
  const statusToneOf = (status) => {
    const key = String(status || "").toLowerCase();
    if (key === "held") return { ...tones.pending, label: "Held" };
    if (key === "delivered") return { ...tones.completed, label: "Delivered" };
    return (
      tones[key] || { label: undefined, color: c.textMuted, bg: c.surfaceHover }
    );
  };

  const getStatusText = (status) => {
    if (!status) return "Unknown";
    const normalizedStatus = String(status);
    return (
      normalizedStatus.charAt(0).toUpperCase() +
      normalizedStatus.slice(1).toLowerCase()
    );
  };

  const formatDate = (dateString) => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const counts = useMemo(() => {
    const acc = { total: transactions.length, completed: 0, pending: 0 };
    transactions.forEach((transaction) => {
      const key = String(
        transaction.jehuca_order_status || transaction.status || "",
      ).toLowerCase();
      if (key === "completed" || key === "delivered") acc.completed += 1;
      else if (key === "pending" || key === "processing" || key === "held")
        acc.pending += 1;
    });
    return acc;
  }, [transactions]);

  return (
    <View style={s.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      <ScrollView
        contentContainerStyle={[s.scrollContent, { paddingBottom: dockPadding }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.mint}
            colors={[c.mint]}
            progressBackgroundColor={c.surface}
          />
        }
      >
        <View style={s.header}>
          <TouchableOpacity
            style={s.backButton}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={20} color={c.textPrimary} />
          </TouchableOpacity>
          <View style={s.headerTextWrap}>
            <Text style={s.headerTitle}>Transaction History</Text>
            <Text style={s.headerSubtitle}>
              {counts.total === 0
                ? "No orders yet"
                : `${counts.total} order${counts.total === 1 ? "" : "s"}`}
            </Text>
          </View>
        </View>

        {/* Summary strip - only meaningful once there is something to summarise */}
        {!loading && counts.total > 0 ? (
          <View style={s.summary}>
            <SummaryTile
              label="Completed"
              value={counts.completed}
              tone={tones.completed}
              labelColor={c.textMuted}
            />
            <View style={s.summaryDivider} />
            <SummaryTile
              label="In progress"
              value={counts.pending}
              tone={tones.pending}
              labelColor={c.textMuted}
            />
            <View style={s.summaryDivider} />
            <SummaryTile
              label="Total"
              value={counts.total}
              tone={{ color: c.mint }}
              labelColor={c.textMuted}
            />
          </View>
        ) : null}

        {loading ? (
          <View style={s.list}>
            {[0, 1, 2, 3].map((index) => (
              <Animated.View
                key={`history-placeholder-${index}`}
                style={[s.placeholder, { opacity: skeletonOpacity }]}
              >
                <View style={s.placeholderBody}>
                  <View style={s.placeholderLine} />
                  <View style={s.placeholderLineShort} />
                </View>
                <View style={s.placeholderTail}>
                  <View style={s.placeholderAmount} />
                  <View style={s.placeholderBadge} />
                </View>
              </Animated.View>
            ))}
          </View>
        ) : transactions.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title="No transactions yet"
            message="Your purchases will appear here once you buy a data bundle."
          />
        ) : (
          <View style={s.list}>
            {transactions.map((transaction) => {
              const isSubAgent =
                isSuperAgentUser && transaction.isSubAgentTransaction;
              const tone = statusToneOf(
                transaction.jehuca_order_status || transaction.status,
              );
              const statusLabel =
                tone.label ||
                getStatusText(
                  transaction.jehuca_order_status || transaction.status,
                );
              const held = String(transaction.status).toLowerCase() === "held";

              return (
                <TouchableOpacity
                  key={`${transaction.orderType}-${transaction.id}`}
                  style={s.card}
                  activeOpacity={0.85}
                  onPress={() =>
                    navigation.navigate("Receipt", { transaction })
                  }
                  accessibilityRole="button"
                >
                  <View style={s.cardHeader}>
                    <View style={s.cardHeadText}>
                      <Text style={s.cardTitle} numberOfLines={1}>
                        {transaction.orderType === "agent"
                          ? `${
                              transaction.isSubAgentTransaction
                                ? "Sub-agent order"
                                : "Agent service"
                            } · ${
                              transaction.isSubAgentTransaction
                                ? transaction.subAgentBusinessName ||
                                  "Sub-agent"
                                : transaction.displayPhone || "Customer"
                            }`
                          : transaction.offer_title || "Purchase"}
                      </Text>
                      <Text style={s.cardDate}>
                        {formatDate(transaction.created_at)}
                      </Text>
                    </View>
                    {!isSubAgent ? (
                      <Text style={s.cardAmount}>
                        {transaction.amount
                          ? `Ghc ${transaction.amount}`
                          : "N/A"}
                      </Text>
                    ) : null}
                  </View>

                  <Text style={s.cardDesc} numberOfLines={2}>
                    {transaction.orderType === "agent"
                      ? transaction.isSubAgentTransaction
                        ? `${transaction.network || "Data"} · ${
                            transaction.recipient_phone ||
                            "Recipient unavailable"
                          }`
                        : `Phone: ${transaction.displayPhone || "N/A"}`
                      : (transaction.network
                          ? `${transaction.network.toUpperCase()} - `
                          : "") + (transaction.data_amount || "Data Bundle")}
                  </Text>

                  {/* Sub-agent orders carry a settlement breakdown instead of a
                      top-level amount, so the status pill moves down here. */}
                  {isSubAgent ? (
                    <View style={s.breakdown}>
                      <View style={s.breakdownHead}>
                        <Text style={s.breakdownEyebrow}>
                          Super agent settlement
                        </Text>
                        <View style={[s.pill, { backgroundColor: tone.bg }]}>
                          <Text style={[s.pillText, { color: tone.color }]}>
                            {statusLabel}
                          </Text>
                        </View>
                      </View>

                      <View style={s.breakdownRows}>
                        <BreakdownRow
                          label="Customer payment"
                          value={formatGhc(transaction.amount)}
                          labelColor={c.textMuted}
                        />
                        <BreakdownRow
                          label="Amount received"
                          value={formatGhc(transaction.super_agent_share)}
                          emphasis
                          tint={c.mint}
                          labelColor={c.textMuted}
                        />
                        <BreakdownRow
                          label="Paystack fee"
                          value={formatGhc(transaction.transaction_fee)}
                          tint={c.amber}
                          labelColor={c.textMuted}
                        />
                      </View>

                      <View style={s.breakdownFoot}>
                        <Text style={s.breakdownFootLabel}>
                          Fee kept by the platform
                        </Text>
                        <Text style={s.breakdownFootValue}>
                          {formatGhc(transaction.main_account_amount)}
                        </Text>
                      </View>
                    </View>
                  ) : (
                    <View style={s.cardFoot}>
                      <View style={[s.pill, { backgroundColor: tone.bg }]}>
                        <Text style={[s.pillText, { color: tone.color }]}>
                          {statusLabel}
                        </Text>
                      </View>
                      <Ionicons
                        name="chevron-forward"
                        size={15}
                        color={c.textMuted}
                      />
                    </View>
                  )}

                  {isSubAgent && held ? (
                    <TouchableOpacity
                      style={s.reorderButton}
                      onPress={() => reorderHeldOrder(transaction)}
                      disabled={reorderingId === transaction.id}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="refresh" size={14} color={c.onAccent} />
                      <Text style={s.reorderText}>
                        {reorderingId === transaction.id
                          ? "Retrying…"
                          : "Reorder"}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function SummaryTile({ label, value, tone, labelColor }) {
  return (
    <View style={styles.summaryTile}>
      <Text style={[styles.summaryValue, { color: tone.color }]}>{value}</Text>
      <Text style={[styles.summaryLabel, { color: labelColor }]}>{label}</Text>
    </View>
  );
}

function BreakdownRow({ label, value, emphasis, tint, labelColor }) {
  return (
    <View style={styles.breakdownRow}>
      <Text style={[styles.breakdownLabel, { color: labelColor }]}>
        {label}
      </Text>
      <Text
        style={[
          styles.breakdownValue,
          emphasis ? styles.breakdownValueEmphasis : null,
          tint ? { color: tint } : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

// Cross-platform elevation. Mirrors HomeScreen/ProfileScreen: `boxShadow` for
// web (where `shadow*` flattens), native props elsewhere, palette tone.
const shadow = (elevation, shadowOpacity = 0.16, tone = "#000000") =>
  Platform.select({
    ios: {
      shadowColor: tone,
      shadowOffset: { width: 0, height: elevation },
      shadowOpacity,
      shadowRadius: elevation * 1.6,
    },
    android: { elevation },
    default: {
      boxShadow: `${tone}${Math.round(shadowOpacity * 255)
        .toString(16)
        .padStart(2, "0")} 0px ${elevation}px ${elevation * 1.8}px`,
    },
  });

const useHistoryStyles = (c, topInset) =>
  useMemo(() => buildStyles(c, topInset), [c, topInset]);

// `topInset` is the Android status-bar height. The app is edge-to-edge there
// and this screen draws its own header (no navigator header), so it must
// inset itself.
const buildStyles = (c, topInset = 0) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.canvas,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingBottom: 36,
    },

    /* ---------- Header ---------- */
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingTop: 8 + topInset,
      paddingBottom: 18,
    },
    backButton: {
      width: 40,
      height: 40,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    headerTextWrap: {
      flex: 1,
    },
    headerTitle: {
      fontFamily: fonts.display,
      fontSize: 21,
      color: c.textPrimary,
    },
    headerSubtitle: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textMuted,
      marginTop: 2,
    },

    /* ---------- Summary ---------- */
    summary: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.hairline,
      paddingVertical: 14,
      marginBottom: 18,
      ...shadow(3, 0.14, c.shadow),
    },
    summaryDivider: {
      width: StyleSheet.hairlineWidth,
      height: 28,
      backgroundColor: c.hairline,
    },

    /* ---------- Cards ---------- */
    list: {
      gap: 12,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 16,
      ...shadow(4, 0.16, c.shadow),
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
    },
    cardHeadText: {
      flex: 1,
    },
    cardTitle: {
      fontFamily: fonts.bodySemi,
      fontSize: 15,
      color: c.textPrimary,
    },
    cardDate: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.textMuted,
      marginTop: 3,
    },
    cardAmount: {
      fontFamily: fonts.displayBold,
      fontSize: 16,
      color: c.textPrimary,
    },
    cardDesc: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textSecondary,
      marginTop: 8,
    },
    cardFoot: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 12,
    },

    /* ---------- Status pill ---------- */
    pill: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      alignSelf: "flex-start",
    },
    pillText: {
      fontFamily: fonts.bodyBold,
      fontSize: 10,
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },

    /* ---------- Settlement breakdown ---------- */
    breakdown: {
      marginTop: 14,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.hairline,
      backgroundColor: c.surfaceSunken,
      padding: 14,
    },
    breakdownHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10,
    },
    breakdownEyebrow: {
      fontFamily: fonts.bodySemi,
      fontSize: 9.5,
      color: c.mintDim,
      letterSpacing: 1.1,
      textTransform: "uppercase",
      flex: 1,
    },
    breakdownRows: {
      gap: 7,
    },
    breakdownFoot: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 11,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.hairline,
    },
    breakdownFootLabel: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.textMuted,
    },
    breakdownFootValue: {
      fontFamily: fonts.bodyBold,
      fontSize: 12.5,
      color: c.textSecondary,
    },

    /* ---------- Reorder ---------- */
    reorderButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      height: 42,
      borderRadius: 999,
      backgroundColor: c.mint,
      marginTop: 12,
    },
    reorderText: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.onAccent,
    },

    /* ---------- Skeleton ---------- */
    placeholder: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      height: 92,
      borderRadius: 22,
      backgroundColor: c.skeleton,
      padding: 16,
    },
    placeholderBody: {
      flex: 1,
      gap: 9,
    },
    placeholderTail: {
      alignItems: "flex-end",
      gap: 9,
    },
    placeholderLine: {
      height: 12,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
      width: "70%",
    },
    placeholderLineShort: {
      height: 10,
      borderRadius: 5,
      backgroundColor: c.surfaceHover,
      width: "45%",
    },
    placeholderAmount: {
      height: 13,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
      width: 72,
    },
    placeholderBadge: {
      height: 18,
      borderRadius: 9,
      backgroundColor: c.surfaceHover,
      width: 62,
    },
  });

// Typography for the summary tiles and settlement rows. The per-row VALUES are
// tinted at the call site (they carry semantic colour); labels are plain.
const styles = StyleSheet.create({
  summaryTile: {
    flex: 1,
    alignItems: "center",
  },
  summaryValue: {
    fontFamily: fonts.displayBold,
    fontSize: 20,
  },
  summaryLabel: {
    fontFamily: fonts.body,
    fontSize: 11,
    marginTop: 2,
  },
  breakdownRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  breakdownLabel: {
    fontFamily: fonts.body,
    fontSize: 12.5,
  },
  breakdownValue: {
    fontFamily: fonts.bodySemi,
    fontSize: 12.5,
  },
  breakdownValueEmphasis: {
    fontFamily: fonts.bodyBold,
    fontSize: 13.5,
  },
});
