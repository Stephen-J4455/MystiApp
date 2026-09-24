import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Animated,
  StatusBar,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import colors from "../components/theme";
import { useAppVersion } from "../hooks/useAppVersion";

export default function ProfileScreen({ navigation }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const { showError, showSuccess } = useNotification();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [isAgent, setIsAgent] = useState(false);
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [agentStats, setAgentStats] = useState({
    totalOrders: 0,
    totalEarnings: 0,
    pendingOrders: 0,
    completedOrders: 0,
  });
  const { appVersion } = useAppVersion();
  const profileSkeletonOpacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    getCurrentUser();
  }, []);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(profileSkeletonOpacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(profileSkeletonOpacity, {
          toValue: 0.6,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [profileSkeletonOpacity]);

  // Real-time updates for agent data
  useEffect(() => {
    let agentOrdersSubscription = null;

    const setupRealtimeSubscriptions = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user && isAgent) {
          agentOrdersSubscription = supabase
            .channel("profile_agent_orders_realtime")
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "agent_orders",
                filter: `agent_id=eq.${user.id}`,
              },
              (payload) => {
                console.log("Agent order updated in profile:", payload);
                fetchAgentStats();
              },
            )
            .subscribe();
        }
      } catch (error) {
        console.error(
          "Error setting up profile realtime subscriptions:",
          error,
        );
      }
    };

    if (isAgent) {
      setupRealtimeSubscriptions();
    }

    return () => {
      if (agentOrdersSubscription) {
        supabase.removeChannel(agentOrdersSubscription);
      }
    };
  }, [isAgent]);

  // Refresh sub-agent activity when the screen comes into focus.
  useFocusEffect(
    React.useCallback(() => {
      if (isAgent) {
        fetchRecentTransactions();
      }
    }, [isAgent]),
  );

  const getCurrentUser = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      setUser(user);
      setFullName(user.user_metadata?.full_name || "");
      setEmail(user.email || "");
      setPhone(user.user_metadata?.phone || "");
      setNotificationsEnabled(
        user.user_metadata?.notifications_enabled ?? true,
      );

      const normalizedRole = String(
        user.user_metadata?.role || user.app_metadata?.role || "",
      ).toLowerCase();
      const agentStatus =
        normalizedRole === "agent" ||
        normalizedRole === "sub_agent" ||
        Boolean(
          user.user_metadata?.super_agent_id ||
          user.user_metadata?.superAgentId ||
          user.app_metadata?.super_agent_id ||
          user.app_metadata?.superAgentId,
        );
      setIsAgent(agentStatus);

      if (agentStatus) {
        await fetchAgentStats();
      }
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
            order.status === "delivered" || order.status === "completed",
        )
        .reduce((sum, order) => sum + (order.amount || 0), 0);

      const pendingOrders = orders.filter(
        (order) => order.status === "pending" || order.status === "processing",
      ).length;

      const completedOrders = orders.filter(
        (order) => order.status === "delivered" || order.status === "completed",
      ).length;

      setAgentStats({
        totalOrders,
        totalEarnings,
        pendingOrders,
        completedOrders,
      });
    } catch (error) {
      console.error("Error fetching agent stats:", error);
    }
  };

  const fetchRecentTransactions = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const { data: transactions, error } = await supabase
          .from("agent_orders")
          .select("*")
          .eq("agent_id", user.id)
          .order("created_at", { ascending: false })
          .limit(5);

        if (!error && transactions) {
          setRecentTransactions(transactions);
        }
      }
    } catch (error) {
      console.error("Error fetching recent transactions:", error);
    }
  };

  const handleUpdateProfile = async () => {
    if (!fullName.trim()) {
      showError("Error", "Please enter your full name");
      return;
    }

    // Ghana phone number validation (optional field)
    // Accepts formats: 0532973455, +233532973455, 233532973455
    if (phone.trim()) {
      const cleanPhone = phone.replace(/[\s\-\(\)]/g, "");
      const ghanaPhoneRegex = /^(\+?233|0)?[2356789]\d{8}$/;
      if (!ghanaPhoneRegex.test(cleanPhone)) {
        showError(
          "Error",
          "Please enter a valid Ghana phone number (e.g., 0532973455 or +233532973455)",
        );
        return;
      }
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: {
          full_name: fullName.trim(),
          phone: phone.trim() || null,
        },
      });

      if (error) {
        showError("Update Failed", error.message);
      } else {
        showSuccess("Success", "Profile updated successfully!");
        setIsEditing(false);
        // Refresh user data
        await getCurrentUser();
      }
    } catch (error) {
      showError("Error", "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
      showSuccess("Signed Out", "You have been signed out successfully");
    } catch (error) {
      showError("Error", "Failed to sign out");
    }
  };

  const handleUpdatePreferences = async (enabled) => {
    try {
      const { error } = await supabase.auth.updateUser({
        data: {
          notifications_enabled: enabled,
        },
      });
      if (error) {
        showError("Update Failed", error.message);
      } else {
        showSuccess("Success", "Preferences updated successfully!");
      }
    } catch (error) {
      showError("Error", "An unexpected error occurred");
    }
  };

  if (!user) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.skeletonContainer}>
          <Animated.View
            style={[styles.skeletonAvatar, { opacity: profileSkeletonOpacity }]}
          />
          <Animated.View
            style={[styles.skeletonCard, { opacity: profileSkeletonOpacity }]}
          >
            <View style={styles.skeletonLineLarge} />
            <View style={styles.skeletonLine} />
            <View style={styles.skeletonLineShort} />
            <View style={styles.skeletonLine} />
            <View style={styles.skeletonLineShort} />
          </Animated.View>
          <Animated.View
            style={[styles.skeletonCard, { opacity: profileSkeletonOpacity }]}
          >
            <View style={styles.skeletonLineLarge} />
            <View style={styles.skeletonRow}>
              <View style={styles.skeletonToggle} />
              <View style={styles.skeletonToggle} />
            </View>
          </Animated.View>
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

      {/* Floating Back Button */}
      <TouchableOpacity
        style={styles.floatingBackButton}
        onPress={() => navigation.goBack()}
      >
        <View style={styles.backButtonCircle}>
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </View>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <View style={styles.profileImageContainer}>
            <View style={styles.avatarRing}>
              <Ionicons
                name="person-circle"
                size={100}
                color={colors.primary}
              />
            </View>
          </View>

          <View style={styles.infoSection}>
            <Text style={styles.sectionTitle}>Personal Information</Text>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Full Name</Text>
              {isEditing ? (
                <TextInput
                  style={styles.input}
                  value={fullName}
                  onChangeText={setFullName}
                  placeholder="Enter your full name"
                  placeholderTextColor={colors.secondary}
                />
              ) : (
                <View style={styles.nameContainer}>
                  <Text style={styles.valueText}>{fullName || "Not set"}</Text>
                  {isAgent && (
                    <View style={styles.agentBadge}>
                      <Ionicons
                        name="shield-checkmark"
                        size={14}
                        color="#fff"
                      />
                      <Text style={styles.agentBadgeText}>AGENT</Text>
                    </View>
                  )}
                </View>
              )}
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Phone Number</Text>
              {isEditing ? (
                <TextInput
                  style={styles.input}
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="Enter your phone number (e.g., 0532973455)"
                  placeholderTextColor={colors.secondary}
                  keyboardType="phone-pad"
                />
              ) : (
                <Text style={styles.valueText}>{phone || "Not set"}</Text>
              )}
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Email</Text>
              <Text style={styles.valueText}>{email}</Text>
              <Text style={styles.noteText}>* Email cannot be changed</Text>
            </View>

            <View style={styles.buttonContainer}>
              {isEditing ? (
                <View style={styles.editButtons}>
                  <TouchableOpacity
                    style={[styles.button, styles.cancelButton]}
                    onPress={() => {
                      setIsEditing(false);
                      setFullName(user.user_metadata?.full_name || "");
                      setPhone(user.user_metadata?.phone || "");
                    }}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.button, styles.saveButton]}
                    onPress={handleUpdateProfile}
                    disabled={loading}
                  >
                    <Text style={styles.buttonText}>
                      {loading ? "Saving..." : "Save"}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.button}
                  onPress={() => setIsEditing(true)}
                >
                  <Text style={styles.buttonText}>Edit Profile</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <View style={styles.preferenceSection}>
            <Text style={styles.sectionTitle}>Preferences</Text>
            <View style={styles.preferenceItem}>
              <Text style={styles.preferenceLabel}>Enable Notifications</Text>
              <Switch
                value={notificationsEnabled}
                onValueChange={(value) => {
                  setNotificationsEnabled(value);
                  handleUpdatePreferences(value);
                }}
              />
            </View>
          </View>

          <View style={styles.appInfoSection}>
            <TouchableOpacity
              style={styles.appInfoItem}
              onPress={() => navigation.navigate("PrivacyPolicy")}
            >
              <Ionicons
                name="document-text-outline"
                size={20}
                color={colors.primary}
              />
              <Text style={styles.appInfoText}>Privacy Policy</Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={colors.secondary}
              />
            </TouchableOpacity>
            <View style={styles.appInfoItem}>
              <Ionicons
                name="information-circle-outline"
                size={20}
                color={colors.primary}
              />
              <Text style={styles.appInfoText}>App Version</Text>
              <Text style={styles.appVersionText}>{appVersion}</Text>
            </View>
          </View>

          <View style={styles.signOutSection}>
            <TouchableOpacity
              style={styles.signOutButton}
              onPress={handleSignOut}
            >
              <Ionicons name="log-out-outline" size={20} color="#e74c3c" />
              <Text style={styles.signOutText}>Sign Out</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.white,
  },
  skeletonContainer: {
    flex: 1,
    padding: 20,
    paddingTop: 40,
  },
  skeletonAvatar: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: colors.border,
    alignSelf: "center",
    marginBottom: 30,
  },
  skeletonCard: {
    backgroundColor: colors.white,
    borderRadius: 24,
    padding: 24,
    marginBottom: 20,
  },
  skeletonLineLarge: {
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.border,
    width: "60%",
    marginBottom: 16,
  },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: "85%",
    marginBottom: 12,
  },
  skeletonLineShort: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: "65%",
    marginBottom: 12,
  },
  skeletonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  skeletonToggle: {
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.border,
    width: "45%",
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
  scrollContent: {
    paddingBottom: 40,
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
  content: {
    padding: 20,
  },
  profileImageContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 30,
  },
  avatarRing: {
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 2,
    borderColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
    padding: 3,
  },
  infoSection: {
    backgroundColor: colors.white,
    borderRadius: 24,
    padding: 24,
    marginBottom: 20,
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
    marginBottom: 20,
  },
  inputContainer: {
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.dark,
    opacity: 0.6,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 14,
    fontSize: 16,
    color: colors.dark,
    backgroundColor: colors.light,
  },
  valueText: {
    fontSize: 16,
    color: colors.dark,
    fontWeight: "500",
    paddingVertical: 4,
  },
  nameContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  agentBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  agentBadgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: "bold",
    marginLeft: 4,
  },
  noteText: {
    fontSize: 12,
    color: colors.dark,
    opacity: 0.4,
    marginTop: 4,
  },
  button: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: "center",
    elevation: 4,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  buttonText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "bold",
  },
  editButtons: {
    flexDirection: "row",
    gap: 12,
  },
  cancelButton: {
    backgroundColor: colors.light,
    flex: 1,
    elevation: 0,
  },
  saveButton: {
    flex: 1,
  },
  cancelButtonText: {
    color: colors.primary,
    fontWeight: "600",
  },
  preferenceSection: {
    backgroundColor: colors.white,
    borderRadius: 24,
    padding: 24,
    marginBottom: 20,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  preferenceItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  preferenceLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.dark,
  },
  appInfoSection: {
    backgroundColor: colors.white,
    borderRadius: 24,
    padding: 12,
    marginBottom: 20,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  appInfoItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
  },
  appInfoText: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    color: colors.dark,
  },
  appVersionText: {
    fontSize: 14,
    color: colors.dark,
    opacity: 0.4,
  },
  signOutSection: {
    marginTop: 10,
  },
  signOutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF5F5",
    paddingVertical: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#FFDADA",
    gap: 10,
  },
  signOutText: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: "700",
  },
});
