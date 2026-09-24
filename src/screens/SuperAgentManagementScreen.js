import React, { useEffect, useState } from "react";
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
import { isSuperAgent } from "../lib/superAgent";
import colors from "../components/theme";

export default function SuperAgentManagementScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const { showError } = useNotification();

  useEffect(() => {
    let mounted = true;

    const loadData = async () => {
      try {
        const {
          data: { user: currentUser },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !currentUser) {
          navigation.replace("Login");
          return;
        }

        if (!isSuperAgent(currentUser)) {
          navigation.replace("Home");
          return;
        }

        if (mounted) {
          setUser(currentUser);
        }
      } catch (error) {
        console.error("Error loading super agent management screen:", error);
        showError("Error", "Unable to load super agent management right now.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadData();

    return () => {
      mounted = false;
    };
  }, [navigation, showError]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading super agent tools...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>Super Agent</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Management Center</Text>
          <Text style={styles.cardText}>
            Welcome{user?.email ? `, ${user.email}` : ""}. Your super agent
            tools are ready.
          </Text>
        </View>

        <View style={styles.infoBanner}>
          <Ionicons
            name="information-circle"
            size={20}
            color={colors.primary}
          />
          <Text style={styles.infoBannerText}>
            Admin sets the base price for every bundle. Use Tier Management to
            set what your agents pay per tier, then assign offers from there.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentOffers")}
        >
          <Ionicons name="pricetag" size={20} color="#fff" />
          <Text style={styles.actionText}>Manage Offers</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentAgents")}
        >
          <Ionicons name="people" size={20} color="#fff" />
          <Text style={styles.actionText}>Manage Agents</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentTierManagement")}
        >
          <Ionicons name="layers" size={20} color="#fff" />
          <Text style={styles.actionText}>Manage Tiers</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentPaystack")}
        >
          <Ionicons name="card" size={20} color="#fff" />
          <Text style={styles.actionText}>Paystack Settings</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentTransactions")}
        >
          <Ionicons name="receipt" size={20} color="#fff" />
          <Text style={styles.actionText}>Transactions</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentHeldOrders")}
        >
          <Ionicons name="refresh-circle" size={20} color="#fff" />
          <Text style={styles.actionText}>Held Agent Orders</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentTopUpHistory")}
        >
          <Ionicons name="wallet" size={20} color="#fff" />
          <Text style={styles.actionText}>Sub-agent Top-up History</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
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
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    flex: 1,
    textAlign: "center",
    marginRight: 40,
    fontSize: 20,
    fontWeight: "800",
    color: colors.dark,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: 18,
    marginBottom: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.primary,
    marginBottom: 8,
  },
  cardText: {
    color: colors.dark,
    fontSize: 14,
    lineHeight: 22,
  },
  infoBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.tint,
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
  },
  infoBannerText: {
    flex: 1,
    marginLeft: 10,
    color: colors.dark,
    fontSize: 13,
    lineHeight: 19,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 16,
    marginBottom: 14,
    shadowColor: colors.primary,
    shadowOpacity: 0.25,
    shadowRadius: 10,
  },
  actionText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    marginLeft: 10,
  },
});
