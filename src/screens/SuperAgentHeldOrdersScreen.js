import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { getEdgeFunctionName } from "../lib/env";
import { useNotification } from "../contexts/NotificationContext";
import colors from "../components/theme";

export default function SuperAgentHeldOrdersScreen({ navigation }) {
  const { showError, showSuccess } = useNotification();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const { data: user } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("agent_orders")
        .select("*")
        .eq("super_agent_id", user?.user?.id)
        .eq("status", "held")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Failed to load held agent orders:", error);
      showError("Error", "Could not load held orders.");
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const retryOrder = async (order) => {
    setRetrying(order.id);
    try {
      const reorderFunctionName = getEdgeFunctionName(
        "reorder-held-agent-order",
      );
      let reorderResult = await supabase.functions.invoke(reorderFunctionName, {
        body: { order_id: order.id },
      });
      if (
        reorderResult.error &&
        reorderFunctionName !== "reorder-held-agent-order"
      ) {
        reorderResult = await supabase.functions.invoke(
          "reorder-held-agent-order",
          { body: { order_id: order.id } },
        );
      }
      const { data, error } = reorderResult;
      if (error || !data?.success)
        throw new Error(data?.error || error?.message || "Retry failed");
      showSuccess(
        "Order Reordered",
        "The held order was sent to the provider.",
      );
      await loadOrders();
    } catch (error) {
      console.error("Held order retry failed:", error);
      showError(
        "Reorder Failed",
        error.message || "Could not reorder this package.",
      );
    } finally {
      setRetrying(null);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Held Agent Orders</Text>
          <Text style={styles.subtitle}>Orders waiting for wallet funding</Text>
        </View>
      </View>
      {loading ? (
        <ActivityIndicator style={styles.loader} color={colors.primary} />
      ) : (
        <FlatList
          contentContainerStyle={styles.content}
          data={orders}
          keyExtractor={(item) => String(item.id)}
          onRefresh={loadOrders}
          refreshing={loading}
          ListEmptyComponent={<Text style={styles.empty}>No held orders.</Text>}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.orderTitle}>
                {item.offer_title || `${item.network} Data Bundle`}
              </Text>
              <Text style={styles.detail}>Agent: {item.agent_id}</Text>
              <Text style={styles.detail}>
                Amount: Ghc{" "}
                {Number(item.base_amount || item.amount || 0).toFixed(2)}
              </Text>
              <Text style={styles.detail}>
                Recipient: {item.recipient_phone || "N/A"}
              </Text>
              <TouchableOpacity
                style={styles.button}
                onPress={() => retryOrder(item)}
                disabled={retrying === item.id}
              >
                {retrying === item.id ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons name="refresh" size={18} color="#fff" />
                    <Text style={styles.buttonText}>Reorder</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.light },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 20,
    backgroundColor: "#fff",
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.text },
  subtitle: { color: colors.textSecondary, marginTop: 4 },
  loader: { marginTop: 40 },
  content: { padding: 16, gap: 12 },
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 16, gap: 6 },
  orderTitle: { fontSize: 16, fontWeight: "800", color: colors.text },
  detail: { color: colors.textSecondary },
  button: {
    marginTop: 10,
    backgroundColor: colors.primary,
    borderRadius: 8,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  buttonText: { color: "#fff", fontWeight: "700" },
  empty: { textAlign: "center", color: colors.textSecondary, marginTop: 40 },
});
