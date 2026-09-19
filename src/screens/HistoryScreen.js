import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Animated,
  StatusBar,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import colors from "../components/theme";

export default function HistoryScreen({ navigation }) {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isAgent, setIsAgent] = useState(false);
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
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [skeletonOpacity]);

  // Real-time updates for orders
  useEffect(() => {
    let ordersSubscription = null;
    let agentOrdersSubscription = null;

    const setupRealtimeSubscriptions = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          // Subscribe to regular orders
          ordersSubscription = supabase
            .channel("history_orders_realtime")
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "orders",
                filter: `user_id=eq.${user.id}`,
              },
              (payload) => {
                console.log("Order updated:", payload);
                // Refresh transactions when order status changes
                checkAgentStatus(true);
              }
            )
            .subscribe();

          // Subscribe to agent orders if user is agent
          const { data: wallet } = await supabase
            .from("agent_wallet")
            .select("*")
            .eq("agent_id", user.id)
            .single();

          if (wallet) {
            agentOrdersSubscription = supabase
              .channel("history_agent_orders_realtime")
              .on(
                "postgres_changes",
                {
                  event: "*",
                  schema: "public",
                  table: "agent_orders",
                  filter: `agent_id=eq.${user.id}`,
                },
                (payload) => {
                  console.log("Agent order updated:", payload);
                  // Refresh transactions when agent order status changes
                  checkAgentStatus(true);
                }
              )
              .subscribe();
          }
        }
      } catch (error) {
        console.error("Error setting up orders realtime subscriptions:", error);
      }
    };

    setupRealtimeSubscriptions();

    return () => {
      if (ordersSubscription) {
        supabase.removeChannel(ordersSubscription);
      }
      if (agentOrdersSubscription) {
        supabase.removeChannel(agentOrdersSubscription);
      }
    };
  }, []);

  const checkAgentStatus = async (isRefresh = false) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data: wallet, error } = await supabase
          .from("agent_wallet")
          .select("*")
          .eq("agent_id", user.id)
          .single();

        const agentStatus = !error && wallet !== null;
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
    isRefresh = false
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
            })
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
            const normalizedAgentOrders = (agentOrders || []).map((order) => ({
              ...order,
              orderType: "agent",
              displayName: order.recipient_name,
              displayPhone: order.recipient_phone,
            }));
            allTransactions = [...allTransactions, ...normalizedAgentOrders];
          }
        }

        // Sort all transactions by created_at
        allTransactions.sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at)
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

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case "completed":
        return "#27ae60";
      case "processing":
        return "#3498db";
      case "pending":
        return "#f39c12";
      case "failed":
      case "cancelled":
        return "#e74c3c";
      default:
        return colors.primary;
    }
  };

  const getStatusText = (status) => {
    if (!status) return "Unknown";
    return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
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

  return (
    <View style={styles.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="dark-content"
      />

      {/* Floating Back Button */}
      <TouchableOpacity
        style={styles.floatingBackButton}
        onPress={() => navigation.goBack()}
      >
        <View style={styles.backButtonCircle}>
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </View>
      </TouchableOpacity>

      {/* Transaction List */}
      <ScrollView
        style={styles.scrollView}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <View style={styles.contentHeader}>
          <Text style={styles.screenTitle}>Transaction History</Text>
        </View>
        {loading ? (
          <View style={styles.transactionList}>
            {[0, 1, 2, 3].map((index) => (
              <Animated.View
                key={`history-placeholder-${index}`}
                style={[
                  styles.transactionPlaceholder,
                  { opacity: skeletonOpacity },
                ]}
              >
                <View style={styles.placeholderLeft}>
                  <View style={styles.placeholderLine} />
                  <View style={styles.placeholderLineShort} />
                  <View style={styles.placeholderLineTiny} />
                </View>
                <View style={styles.placeholderRight}>
                  <View style={styles.placeholderAmount} />
                  <View style={styles.placeholderBadge} />
                </View>
              </Animated.View>
            ))}
          </View>
        ) : transactions.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons
              name="receipt-outline"
              size={64}
              color={colors.secondary}
            />
            <Text style={styles.emptyTitle}>No Transactions Yet</Text>
            <Text style={styles.emptyMessage}>
              Your transaction history will appear here once you make
              purchases
            </Text>
          </View>
        ) : (
          <View style={styles.transactionList}>
            {transactions.map((transaction) => (
              <TouchableOpacity
                key={transaction.id}
                style={styles.transactionCard}
                onPress={() =>
                  navigation.navigate("Receipt", { transaction })
                }
              >
                <View style={styles.transactionLeft}>
                  <Text style={styles.transactionTitle}>
                    {transaction.orderType === "agent"
                      ? `Agent Service - ${transaction.displayName || "Customer"
                      }`
                      : transaction.offer_title || "Purchase"}
                  </Text>
                  <Text style={styles.transactionDesc}>
                    {transaction.orderType === "agent"
                      ? `Phone: ${transaction.displayPhone || "N/A"}`
                      : (transaction.network
                        ? `${transaction.network.toUpperCase()} - `
                        : "") + (transaction.data_amount || "Data Bundle")}
                  </Text>
                  <Text style={styles.transactionDate}>
                    {formatDate(transaction.created_at)}
                  </Text>
                </View>
                <View style={styles.transactionRight}>
                  <Text
                    style={[
                      styles.transactionAmount,
                      transaction.status?.toLowerCase() === "completed" &&
                      styles.transactionAmountCompleted,
                      transaction.status?.toLowerCase() === "processing" &&
                      styles.transactionAmountProcessing,
                      transaction.status?.toLowerCase() === "pending" &&
                      styles.transactionAmountPending,
                    ]}
                  >
                    {transaction.amount ? `Ghc ${transaction.amount}` : "N/A"}
                  </Text>
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: getStatusColor(transaction.status) },
                    ]}
                  >
                    <Text style={styles.statusText}>
                      {getStatusText(transaction.status)}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = {
  container: {
    flex: 1,
    backgroundColor: colors.white,
  },
  floatingBackButton: {
    position: "absolute",
    top: 50,
    left: 20,
    zIndex: 10,
  },
  backButtonCircle: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: "rgba(255, 255, 255, 0.9)",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  contentHeader: {
    paddingHorizontal: 20,
    marginTop: 110, // Accounts for floating back button
    marginBottom: 10,
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: "bold",
    color: colors.dark,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.white,
  },
  loadingText: {
    fontSize: 14,
    color: colors.dark,
    opacity: 0.5,
    marginTop: 10,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 15,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.white,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
  },
  scrollView: {
    flex: 1,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: colors.dark,
    marginTop: 20,
    marginBottom: 10,
  },
  emptyMessage: {
    fontSize: 14,
    color: colors.dark,
    opacity: 0.5,
    textAlign: "center",
    lineHeight: 22,
  },
  transactionList: {
    padding: 20,
  },
  transactionCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.white,
    padding: 16,
    marginBottom: 15,
    borderRadius: 24,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  transactionPlaceholder: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.white,
    padding: 16,
    marginBottom: 15,
    borderRadius: 24,
  },
  placeholderLeft: {
    flex: 1,
    marginRight: 16,
  },
  placeholderRight: {
    alignItems: "flex-end",
  },
  placeholderLine: {
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.border,
    width: "70%",
    marginBottom: 8,
  },
  placeholderLineShort: {
    height: 10,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: "55%",
    marginBottom: 8,
  },
  placeholderLineTiny: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
    width: "40%",
  },
  placeholderAmount: {
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.border,
    width: 80,
    marginBottom: 10,
  },
  placeholderBadge: {
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.border,
    width: 70,
  },
  transactionLeft: {
    flex: 1,
  },
  transactionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.dark,
    marginBottom: 4,
  },
  transactionDesc: {
    fontSize: 13,
    color: colors.dark,
    opacity: 0.6,
    marginBottom: 6,
  },
  transactionDate: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.4,
  },
  transactionRight: {
    alignItems: "flex-end",
  },
  transactionAmount: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.danger,
    marginBottom: 8,
  },
  transactionAmountCompleted: {
    color: colors.success,
  },
  transactionAmountProcessing: {
    color: colors.primary,
  },
  transactionAmountPending: {
    color: "#f39c12",
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: "bold",
    textTransform: "uppercase",
  },
};
