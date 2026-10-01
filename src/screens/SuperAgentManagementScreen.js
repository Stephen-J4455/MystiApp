import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import { fonts } from "../components/theme";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";

export default function SuperAgentManagementScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const { showError } = useNotification();
  const theme = useTheme();
  const c = theme.c;
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useManagementStyles(c, topInset);
  // The bottom dock is absolutely positioned on native, so it floats over the
  // scroll view. Adds its height plus the safe-area inset so the trailing
  // action cards are never stranded underneath. Web returns just `extra`.
  const dockBottomPadding = useDockBottomPadding(40);

  // The gate is Enterprise-only, so every management action is driven off one
  // resolved badge. Previously this expression was re-evaluated inline five
  // times, which is exactly the kind of duplication that lets the Pro and
  // Enterprise branches drift apart.
  const badge = String(
    user?.user_metadata?.super_agent_badge ||
      user?.app_metadata?.super_agent_badge ||
      "enterprise",
  ).toLowerCase();
  const isEnterprise = badge !== "pro";

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
      <ThemedScreen style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={c.mint} />
          <Text style={styles.loadingText}>Loading super agent tools...</Text>
        </View>
      </ThemedScreen>
    );
  }

  return (
    <ThemedScreen style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={c.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Super Agent</Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: dockBottomPadding },
        ]}
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Management Center</Text>
          <Text style={styles.cardText}>
            Welcome{user?.email ? `, ${user.email}` : ""}. Your super agent
            tools are ready.
          </Text>
        </View>

        <View style={styles.infoBanner}>
          <Ionicons name="information-circle" size={20} color={c.mint} />
          <Text style={styles.infoBannerText}>
            {isEnterprise
              ? "Admin sets the base price for every bundle. Use Tier Management to set what your agents pay per tier, then assign offers from there."
              : "Your Pro badge includes analytics, orders, AFA registration, wallet top-ups, and transaction access. Contact an administrator for Enterprise management tools."}
          </Text>
        </View>

        {isEnterprise ? (
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate("SuperAgentOffers")}
          >
            <Ionicons name="pricetag" size={20} color={c.onAccent} />
            <Text style={styles.actionText}>Manage Offers</Text>
          </TouchableOpacity>
        ) : null}

        {isEnterprise ? (
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate("SuperAgentAgents")}
          >
            <Ionicons name="people" size={20} color={c.onAccent} />
            <Text style={styles.actionText}>Manage Agents</Text>
          </TouchableOpacity>
        ) : null}

        {isEnterprise ? (
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate("SuperAgentTierManagement")}
          >
            <Ionicons name="layers" size={20} color={c.onAccent} />
            <Text style={styles.actionText}>Manage Tiers</Text>
          </TouchableOpacity>
        ) : null}

        {isEnterprise ? (
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate("SuperAgentPaystack")}
          >
            <Ionicons name="card" size={20} color={c.onAccent} />
            <Text style={styles.actionText}>Paystack Settings</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentTransactions")}
        >
          <Ionicons name="receipt" size={20} color={c.onAccent} />
          <Text style={styles.actionText}>Transactions</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentHeldOrders")}
        >
          <Ionicons name="refresh-circle" size={20} color={c.onAccent} />
          <Text style={styles.actionText}>Held Agent Orders</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate("SuperAgentAnalytics")}
        >
          <Ionicons name="analytics" size={20} color={c.onAccent} />
          <Text style={styles.actionText}>Business Analytics</Text>
        </TouchableOpacity>
      </ScrollView>
    </ThemedScreen>
  );
}

// Layered on the shared kit: `themedStyles(c)` owns the surface, border and type
// ramp, so this file only adds the management-hub specific pieces.
const useManagementStyles = (c, topInset = 0) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    ...base,
    safeArea: { ...base.screen },
    loadingContainer: { ...base.center },
    loadingText: { ...base.headerSubtitle, marginTop: 12, fontSize: 15 },

    header: { ...base.header, paddingTop: 18 + topInset, paddingBottom: 12 },
    backButton: { ...base.backButton, borderRadius: 999 },
    title: { ...base.headerTitle, flex: 1, textAlign: "center", fontSize: 20 },

    content: { ...base.body, paddingTop: 20, paddingBottom: 40 },

    cardTitle: {
      fontFamily: fonts.display,
      fontSize: 18,
      color: c.mint,
      marginBottom: 8,
    },
    cardText: {
      fontFamily: fonts.body,
      color: c.textSecondary,
      fontSize: 14,
      lineHeight: 22,
    },

    // Mint-tinted strip, so it reads as guidance rather than an error. The
    // hex-alpha suffixes only work because c.mint is a 6-digit hex in both
    // palettes; a token like c.sky in the light palette is the same, but a
    // `rgba()` token would silently produce an invalid colour here.
    infoBanner: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: `${c.mint}14`,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: `${c.mint}2E`,
      padding: 14,
      marginBottom: 20,
    },
    infoBannerText: {
      flex: 1,
      marginLeft: 10,
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 19,
      color: c.textSecondary,
    },

    actionButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.mint,
      paddingVertical: 16,
      borderRadius: 16,
      marginBottom: 14,
    },
    actionText: {
      fontFamily: fonts.bodyBold,
      color: c.onAccent,
      fontSize: 16,
      marginLeft: 10,
    },
  });
};
