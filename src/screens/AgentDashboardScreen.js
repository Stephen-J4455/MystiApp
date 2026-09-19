import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Dimensions,
  StatusBar,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { BarChart } from "react-native-chart-kit";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import colors from "../components/theme";

const screenWidth = Dimensions.get("window").width;

export default function AgentDashboardScreen({ navigation }) {
  const [agent, setAgent] = useState(null);
  const [stats, setStats] = useState({
    totalOrders: 0,
    totalEarnings: 0,
    pendingOrders: 0,
    completedOrders: 0,
  });
  const [recentOrders, setRecentOrders] = useState([]);
  const [chartData, setChartData] = useState({
    labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    datasets: [{ data: [0, 0, 0, 0, 0, 0, 0] }],
  });
  const [loading, setLoading] = useState(true);
  const { showError } = useNotification();

  useEffect(() => {
    fetchAgentData();
    fetchAgentStats();
    fetchRecentOrders();
    fetchChartData();

    // Set up realtime subscriptions
    let ordersSubscription = null;
    let walletSubscription = null;

    const setupRealtimeSubscriptions = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          ordersSubscription = supabase
            .channel("agent_dashboard_agent_orders_realtime")
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "agent_orders",
                filter: `agent_id=eq.${user.id}`,
              },
              () => {
                fetchAgentStats();
                fetchRecentOrders();
                fetchChartData();
              }
            )
            .subscribe();

          walletSubscription = supabase
            .channel("agent_dashboard_agent_wallet_realtime")
            .on(
              "postgres_changes",
              {
                event: "UPDATE",
                schema: "public",
                table: "agent_wallet",
                filter: `agent_id=eq.${user.id}`,
              },
              (payload) => {
                console.log("Agent wallet updated:", payload);
                // Update agent data when wallet balance changes
                setAgent((prevAgent) => ({
                  ...prevAgent,
                  wallet: payload.new,
                }));
              }
            )
            .subscribe();
        }
      } catch (error) {
        console.error("Error setting up realtime subscriptions:", error);
      }
    };

    setupRealtimeSubscriptions();

    return () => {
      if (ordersSubscription) {
        ordersSubscription.unsubscribe();
      }
      if (walletSubscription) {
        supabase.removeChannel(walletSubscription);
      }
    };
  }, []);

  const fetchAgentData = async () => {
    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError) throw userError;

      // Check if user is an agent
      const { data: wallet, error: walletError } = await supabase
        .from("agent_wallet")
        .select("*")
        .eq("agent_id", user.id)
        .single();

      if (walletError || !wallet) {
        // Not an agent, redirect to home
        navigation.replace("Home");
        return;
      }

      setAgent({
        ...user,
        wallet: wallet,
      });
      setLoading(false);
    } catch (error) {
      console.error("Error fetching agent data:", error);
      showError("Error", "Failed to load agent data");
      setLoading(false);
      navigation.replace("Home");
    }
  };

  const fetchAgentStats = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      // Fetch agent orders stats
      const { data: orders, error: ordersError } = await supabase
        .from("agent_orders")
        .select("status, amount, created_at")
        .eq("agent_id", user.id);

      if (ordersError) throw ordersError;

      const totalOrders = orders.length;
      const totalEarnings = orders
        .filter(
          (order) =>
            order.status === "delivered" || order.status === "completed"
        )
        .reduce((sum, order) => sum + (order.amount || 0), 0);

      const pendingOrders = orders.filter(
        (order) => order.status === "pending" || order.status === "processing"
      ).length;

      const completedOrders = orders.filter(
        (order) => order.status === "delivered" || order.status === "completed"
      ).length;

      setStats({
        totalOrders,
        totalEarnings,
        pendingOrders,
        completedOrders,
      });
    } catch (error) {
      console.error("Error fetching agent stats:", error);
    }
  };

  const fetchRecentOrders = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const { data: orders, error } = await supabase
        .from("agent_orders")
        .select("*")
        .eq("agent_id", user.id)
        .order("created_at", { ascending: false })
        .limit(5);

      if (error) throw error;

      setRecentOrders(orders || []);
    } catch (error) {
      console.error("Error fetching recent orders:", error);
    }
  };

  const fetchChartData = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      // Get orders for the last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const { data: orders, error } = await supabase
        .from("agent_orders")
        .select("created_at, amount")
        .eq("agent_id", user.id)
        .gte("created_at", sevenDaysAgo.toISOString())
        .eq("status", "delivered");

      if (error) throw error;

      // Group by day
      const dailyData = [0, 0, 0, 0, 0, 0, 0];
      orders.forEach((order) => {
        const date = new Date(order.created_at);
        const dayIndex = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
        // Convert to Monday = 0, Sunday = 6
        const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;
        dailyData[adjustedIndex] += order.amount || 0;
      });

      setChartData({
        labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        datasets: [{ data: dailyData }],
      });
    } catch (error) {
      console.error("Error fetching chart data:", error);
    }
  };

  const handleLogout = async () => {
    Alert.alert("Logout", "Are you sure you want to logout?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Logout",
        style: "destructive",
        onPress: async () => {
          try {
            await supabase.auth.signOut();
            navigation.replace("Login");
          } catch (error) {
            showError("Error", "Failed to logout");
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading agent dashboard...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="dark-content"
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        {/* Integrated Header Section */}
        <View style={styles.contentHeaderArea}>
          <View style={styles.headerTop}>
            <View style={styles.headerLeft}>
              <View style={styles.avatarRing}>
                <Ionicons name="person" size={20} color={colors.primary} />
              </View>
              <View>
                <Text style={styles.welcomeText}>Welcome back,</Text>
                <Text style={styles.agentName}>
                  {agent?.user_metadata?.full_name || agent?.email || "Agent"}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={handleLogout} style={styles.logoutButton}>
              <Ionicons name="log-out-outline" size={24} color={colors.primary} />
            </TouchableOpacity>
          </View>

          <View style={styles.dashboardTitleSection}>
            <Text style={styles.dashboardTitle}>Agent Dashboard</Text>
            <Text style={styles.dashboardSubtitle}>Overview of your business performance</Text>
          </View>
        </View>

        {/* Stats Cards */}
        <View style={styles.statsContainer}>
          <View style={styles.statCard}>
            <Ionicons name="cart-outline" size={30} color={colors.primary} />
            <Text style={styles.statNumber}>{stats.totalOrders}</Text>
            <Text style={styles.statLabel}>Total Orders</Text>
          </View>

          <View style={styles.statCard}>
            <Ionicons name="cash-outline" size={30} color={colors.primary} />
            <Text style={styles.statNumber}>
              Ghc{stats.totalEarnings.toFixed(2)}
            </Text>
            <Text style={styles.statLabel}>Total Earnings</Text>
          </View>

          <View style={styles.statCard}>
            <Ionicons name="time-outline" size={30} color={colors.primary} />
            <Text style={styles.statNumber}>{stats.pendingOrders}</Text>
            <Text style={styles.statLabel}>Pending</Text>
          </View>

          <View style={styles.statCard}>
            <Ionicons
              name="checkmark-circle-outline"
              size={30}
              color={colors.primary}
            />
            <Text style={styles.statNumber}>{stats.completedOrders}</Text>
            <Text style={styles.statLabel}>Completed</Text>
          </View>
        </View>

        {/* Earnings Chart */}
        <View style={styles.chartContainer}>
          <Text style={styles.chartTitle}>Weekly Earnings</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            bounces={false}
            style={styles.chartScrollView}
          >
            <BarChart
              data={chartData}
              width={Math.max(screenWidth - 40, chartData.labels.length * 60)}
              height={220}
              yAxisLabel="Ghc"
              chartConfig={{
                backgroundColor: "#ffffffff",
                backgroundGradientFrom: "#ffffffff",
                backgroundGradientTo: "#ffffffff",
                decimalPlaces: 0,
                color: (opacity = 1) => `rgba(0, 103, 105, ${opacity})`,
                labelColor: (opacity = 1) => `rgba(0, 0, 0, ${opacity * 0.6})`,
                style: {
                  borderRadius: 16,
                },
                propsForDots: {
                  r: "6",
                  strokeWidth: "2",
                  stroke: colors.primary,
                },
              }}
              style={{
                marginVertical: 8,
                borderRadius: 0,
              }}
            />
          </ScrollView>
        </View>

        {/* Recent Orders */}
        <View style={styles.ordersContainer}>
          <Text style={styles.sectionTitle}>Recent Orders</Text>
          {recentOrders.length > 0 ? (
            recentOrders.map((order) => (
              <View key={order.id} style={styles.orderItem}>
                <View style={styles.orderInfo}>
                  <Text style={styles.orderId}>Order #{order.id}</Text>
                  <Text style={styles.orderCustomer}>
                    {order.recipient_name || "Unknown Customer"}
                  </Text>
                  <Text style={styles.orderAmount}>
                    Ghc{order.amount ? order.amount.toFixed(2) : "0.00"}
                  </Text>
                </View>
                <View style={styles.orderStatus}>
                  <Text
                    style={[
                      styles.statusText,
                      { color: getStatusColor(order.status) },
                    ]}
                  >
                    {order.status}
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.noOrdersText}>No recent orders</Text>
          )}
        </View>

        {/* Quick Actions */}
        <View style={styles.actionsContainer}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate("History")}
          >
            <Ionicons name="list-outline" size={24} color="white" />
            <Text style={styles.actionButtonText}>View All Orders</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate("Profile")}
          >
            <Ionicons name="person-outline" size={24} color="white" />
            <Text style={styles.actionButtonText}>Profile</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const getStatusColor = (status) => {
  switch (status?.toLowerCase()) {
    case "pending":
      return "#f39c12";
    case "processing":
      return "#3498db";
    case "delivered":
      return "#27ae60";
    case "cancelled":
      return "#e74c3c";
    default:
      return "#95a5a6";
  }
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.white,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 40,
  },
  contentHeaderArea: {
    paddingHorizontal: 20,
    marginTop: 60, // Accounts for status bar
    marginBottom: 10,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 25,
  },
  dashboardTitleSection: {
    marginBottom: 15,
  },
  dashboardTitle: {
    fontSize: 28,
    fontWeight: "bold",
    color: colors.dark,
  },
  dashboardSubtitle: {
    fontSize: 14,
    color: colors.dark,
    opacity: 0.5,
    marginTop: 4,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.white,
  },
  loadingText: {
    marginTop: 10,
    fontSize: 14,
    color: colors.dark,
    opacity: 0.5,
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
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  welcomeText: {
    fontSize: 12,
    color: colors.dark,
    opacity: 0.6,
  },
  agentName: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
  },
  logoutButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  statsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: 15,
    gap: 15,
  },
  statCard: {
    backgroundColor: colors.white,
    padding: 20,
    borderRadius: 24,
    alignItems: "center",
    flex: 1,
    minWidth: "45%",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  statNumber: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.dark,
    marginTop: 10,
  },
  statLabel: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.5,
    marginTop: 2,
    textAlign: "center",
  },
  chartContainer: {
    backgroundColor: colors.white,
    margin: 20,
    borderRadius: 24,
    padding: 24,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  chartScrollView: {
    marginHorizontal: -10,
  },
  chartTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
    marginBottom: 20,
  },
  ordersContainer: {
    backgroundColor: colors.white,
    margin: 20,
    borderRadius: 24,
    padding: 24,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
    marginBottom: 15,
  },
  orderItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  orderInfo: {
    flex: 1,
  },
  orderId: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.dark,
    opacity: 0.4,
  },
  orderCustomer: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.dark,
    marginTop: 2,
  },
  orderAmount: {
    fontSize: 15,
    color: colors.primary,
    fontWeight: "700",
    marginTop: 2,
  },
  orderStatus: {
    alignItems: "center",
  },
  statusText: {
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  noOrdersText: {
    textAlign: "center",
    fontSize: 14,
    color: colors.dark,
    opacity: 0.4,
    paddingVertical: 20,
  },
  actionsContainer: {
    flexDirection: "row",
    paddingHorizontal: 20,
    gap: 15,
  },
  actionButton: {
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    borderRadius: 16,
    flex: 1,
    elevation: 4,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  actionButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: "700",
    marginLeft: 8,
  },
});
