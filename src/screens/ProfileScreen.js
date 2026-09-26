import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Switch,
  Animated,
  StatusBar,
  Platform,
  Linking,
  ScrollView,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect } from "@react-navigation/native";
import { supabase } from "../lib/supabase";
import { removeChannelSafe, uniqueTopic } from "../lib/realtime";
import { useNotification } from "../contexts/NotificationContext";
import { useTheme } from "../contexts/ThemeContext";
import {
  useThemedStyles,
  Field,
  PrimaryButton,
  SecondaryButton,
  RowIcon,
} from "../components/ui";
import ThemePicker from "../components/ThemePicker";
import { useAppVersion } from "../hooks/useAppVersion";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import { fonts } from "../components/theme";

const ADMIN_WHATSAPP = "233532973455";

const initialsOf = (name) => {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
};

export default function ProfileScreen({ navigation }) {
  const { c, isDark } = useTheme();
  // The shared kit is consumed by Field/PrimaryButton/SecondaryButton, which
  // read it from context themselves; the screen keeps its own scheme-scoped
  // stylesheet for layout.
  useThemedStyles();
  // The app is edge-to-edge on Android and this screen has no navigator
  // header, so it must inset itself below the status bar. iOS already spaces
  // its header, so the inset is only consumed there.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const s = useSettingsStyles(c, topInset);
  // Clears the floating bottom dock so the sign-out button stays reachable.
  const dockPadding = useDockBottomPadding(12);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const { showError, showSuccess } = useNotification();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [isAgent, setIsAgent] = useState(false);
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState("");
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
            .channel(uniqueTopic("profile_agent_orders_realtime"))
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
      removeChannelSafe(agentOrdersSubscription);
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

  const resetPasswordForm = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setShowNewPassword(false);
  };

  const cancelProfileEdit = () => {
    setIsEditing(false);
    setFullName(user?.user_metadata?.full_name || "");
    setPhone(user?.user_metadata?.phone || "");
  };

  const handleChangePassword = async () => {
    if (passwordSaving) return;

    setPasswordError("");

    if (!currentPassword) {
      setPasswordError("Enter your current password.");
      return;
    }
    if (!newPassword) {
      setPasswordError("Enter a new password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("The new passwords do not match.");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("Use at least 8 characters.");
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordError("The new password must be different.");
      return;
    }

    setPasswordSaving(true);
    try {
      // Re-authenticate first: Supabase requires the current password to be
      // proven before it will set a new one.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user?.email,
        password: currentPassword,
      });
      if (signInError) {
        setPasswordError("Your current password is incorrect.");
        setPasswordSaving(false);
        return;
      }

      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (error) throw error;

      resetPasswordForm();
      setShowPasswordSection(false);
      showSuccess(
        "Password updated",
        "Use your new password the next time you sign in.",
      );
    } catch (error) {
      console.error("Error changing password:", error);
      setPasswordError(
        error.message || "Could not change your password. Please try again.",
      );
    } finally {
      setPasswordSaving(false);
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

  const openWhatsApp = () => {
    const message = "Hi Admin, I need help with the Mystiwan E-Business app.";
    Linking.openURL(
      `https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(message)}`,
    ).catch((error) => console.warn("Could not open WhatsApp:", error));
  };

  if (!user) {
    return (
      <View style={s.screen}>
        <StatusBar
          translucent
          backgroundColor="transparent"
          barStyle={isDark ? "light-content" : "dark-content"}
        />
        <SafeAreaView style={s.skeletonContainer} edges={["top"]}>
          <Animated.View
            style={[s.skeletonHero, { opacity: profileSkeletonOpacity }]}
          />
          {Array.from({ length: 3 }).map((_, i) => (
            <Animated.View
              key={i}
              style={[s.skeletonCard, { opacity: profileSkeletonOpacity }]}
            >
              <View style={s.skeletonLineWide} />
              <View style={s.skeletonLineNarrow} />
            </Animated.View>
          ))}
        </SafeAreaView>
      </View>
    );
  }

  const displayName = fullName || email.split("@")[0] || "User";

  const accountRows = [
    {
      icon: "mail-outline",
      tint: c.mint,
      title: "Email address",
      value: email,
    },
    {
      icon: "call-outline",
      tint: c.sky,
      title: "Phone number",
      value: phone || "Not set",
      empty: !phone,
    },
  ];

  const aboutRows = [
    {
      icon: "document-text-outline",
      tint: c.sky,
      title: "Privacy Policy",
      onPress: () => navigation.navigate("PrivacyPolicy"),
    },
    {
      icon: "logo-whatsapp",
      tint: "#25D366",
      title: "Contact Admin",
      subtitle: "Chat with us on WhatsApp",
      onPress: openWhatsApp,
    },
  ];

  return (
    <View style={s.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      <ScrollView
        contentContainerStyle={[
          s.scrollContent,
          { paddingBottom: dockPadding },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
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
            <Text style={s.headerTitle}>Settings</Text>
            <Text style={s.headerSubtitle} numberOfLines={1}>
              Account, security and app preferences
            </Text>
          </View>
        </View>

        {/* Identity hero */}
        <View style={s.hero}>
          <LinearGradient
            colors={[c.heroFrom, c.heroTo]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.heroGradient}
          >
            <View style={s.heroTop}>
              <View style={s.avatar}>
                <Text style={s.avatarText}>{initialsOf(displayName)}</Text>
              </View>
              <View style={s.heroIdentity}>
                <Text style={s.heroName} numberOfLines={1}>
                  {displayName}
                </Text>
                <Text style={s.heroEmail} numberOfLines={1}>
                  {email}
                </Text>
                {isAgent ? (
                  <View style={s.heroBadge}>
                    <Ionicons name="shield-checkmark" size={12} color="#fff" />
                    <Text style={s.heroBadgeText}>AGENT</Text>
                  </View>
                ) : null}
              </View>
            </View>

            {isAgent ? (
              <View style={s.heroStats}>
                <HeroStat
                  label="Orders"
                  value={String(agentStats.totalOrders)}
                />
                <View style={s.heroStatDivider} />
                <HeroStat
                  label="Pending"
                  value={String(agentStats.pendingOrders)}
                />
                <View style={s.heroStatDivider} />
                <HeroStat
                  label="Completed"
                  value={String(agentStats.completedOrders)}
                />
              </View>
            ) : null}
          </LinearGradient>
        </View>

        {/* Account */}
        <View style={s.section}>
          <Text style={s.sectionEyebrow}>Account</Text>
          <View style={s.card}>
            {accountRows.map((row, i) => (
              <View key={row.title}>
                {i > 0 ? <View style={s.divider} /> : null}
                <View style={s.row}>
                  <RowIcon icon={row.icon} tint={row.tint} />
                  <View style={s.rowBody}>
                    <Text style={s.rowTitle}>{row.title}</Text>
                    <Text
                      style={[
                        s.rowValue,
                        row.empty ? { color: c.textMuted } : null,
                      ]}
                      numberOfLines={1}
                    >
                      {row.value}
                    </Text>
                  </View>
                  {i === 0 ? (
                    <Ionicons
                      name="lock-closed"
                      size={14}
                      color={c.textMuted}
                    />
                  ) : null}
                </View>
              </View>
            ))}
          </View>

          {isEditing ? (
            <View style={s.editForm}>
              <Text style={s.formTitle}>Edit your details</Text>
              <Field
                label="Full name"
                icon="person-outline"
                value={fullName}
                onChangeText={setFullName}
                placeholder="Enter your full name"
                autoCapitalize="words"
              />
              <Field
                label="Phone number"
                icon="call-outline"
                value={phone}
                onChangeText={setPhone}
                placeholder="e.g. 0532973455"
                keyboardType="phone-pad"
              />
              <View style={s.editActions}>
                <SecondaryButton
                  title="Cancel"
                  onPress={cancelProfileEdit}
                  style={s.flexAction}
                />
                <PrimaryButton
                  title="Save changes"
                  onPress={handleUpdateProfile}
                  loading={loading}
                  style={s.flexAction}
                />
              </View>
            </View>
          ) : (
            <SecondaryButton
              title="Edit profile"
              icon="create-outline"
              onPress={() => setIsEditing(true)}
              style={s.editCta}
            />
          )}
        </View>

        {/* Preferences */}
        <View style={s.section}>
          <Text style={s.sectionEyebrow}>Preferences</Text>
          <View style={s.card}>
            <View style={s.row}>
              <RowIcon icon="notifications-outline" tint={c.amber} />
              <View style={s.rowBody}>
                <Text style={s.rowTitle}>Push notifications</Text>
                <Text style={s.rowSubtitle}>
                  Order updates and account alerts
                </Text>
              </View>
              <Switch
                value={notificationsEnabled}
                onValueChange={(value) => {
                  setNotificationsEnabled(value);
                  handleUpdatePreferences(value);
                }}
                trackColor={{ false: c.surfaceSunken, true: `${c.mint}80` }}
                thumbColor={notificationsEnabled ? c.mint : c.textMuted}
                ios_backgroundColor={c.surfaceSunken}
              />
            </View>

            <View style={s.divider} />

            {/* ThemePicker renders its own "Appearance" label and hint. */}
            <View style={s.themeBlock}>
              <ThemePicker />
            </View>
          </View>
        </View>

        {/* Security */}
        <View style={s.section}>
          <Text style={s.sectionEyebrow}>Security</Text>
          {!showPasswordSection ? (
            <View style={s.cardDivided}>
              <TouchableOpacity
                style={s.row}
                activeOpacity={0.75}
                onPress={() => {
                  resetPasswordForm();
                  setShowPasswordSection(true);
                }}
                accessibilityRole="button"
              >
                <RowIcon icon="lock-closed-outline" tint={c.rose} />
                <View style={s.rowBody}>
                  <Text style={s.rowTitle}>Change password</Text>
                  <Text style={s.rowSubtitle}>Use at least 8 characters</Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={c.textMuted}
                />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.card}>
              <Text style={s.formTitle}>Set a new password</Text>
              <View style={s.formGap}>
                <Field
                  label="Current password"
                  icon="key-outline"
                  value={currentPassword}
                  onChangeText={setCurrentPassword}
                  placeholder="Enter your current password"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="password"
                />
                <Field
                  label="New password"
                  icon="key-outline"
                  value={newPassword}
                  onChangeText={setNewPassword}
                  placeholder="At least 8 characters"
                  secureTextEntry={!showNewPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  affix={showNewPassword ? "eye-off-outline" : "eye-outline"}
                  onAffixPress={() => setShowNewPassword((v) => !v)}
                />
                <Field
                  label="Confirm new password"
                  icon="key-outline"
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="Re-enter the new password"
                  secureTextEntry={!showNewPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  error={passwordError || undefined}
                />
              </View>
              <View style={s.editActions}>
                <SecondaryButton
                  title="Cancel"
                  onPress={() => {
                    resetPasswordForm();
                    setShowPasswordSection(false);
                  }}
                  style={s.flexAction}
                />
                <PrimaryButton
                  title="Update"
                  onPress={handleChangePassword}
                  loading={passwordSaving}
                  style={s.flexAction}
                />
              </View>
            </View>
          )}
        </View>

        {/* About */}
        <View style={s.section}>
          <Text style={s.sectionEyebrow}>About</Text>
          <View style={s.cardDivided}>
            {aboutRows.map((row, i) => (
              <View key={row.title}>
                {i > 0 ? <View style={s.divider} /> : null}
                <TouchableOpacity
                  style={s.row}
                  activeOpacity={0.75}
                  onPress={row.onPress}
                  accessibilityRole="button"
                >
                  <RowIcon icon={row.icon} tint={row.tint} />
                  <View style={s.rowBody}>
                    <Text style={s.rowTitle}>{row.title}</Text>
                    {row.subtitle ? (
                      <Text style={s.rowSubtitle}>{row.subtitle}</Text>
                    ) : null}
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color={c.textMuted}
                  />
                </TouchableOpacity>
              </View>
            ))}

            <View style={s.divider} />

            <View style={s.row}>
              <RowIcon icon="information-circle-outline" tint={c.mintDim} />
              <View style={s.rowBody}>
                <Text style={s.rowTitle}>App version</Text>
                <Text style={s.rowSubtitle}>Mystiwan E-Business</Text>
              </View>
              <Text style={s.versionValue}>{appVersion}</Text>
            </View>
          </View>
        </View>

        {/* Sign out */}
        <View style={s.signOutWrap}>
          <TouchableOpacity
            style={s.signOutButton}
            onPress={handleSignOut}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            <Ionicons name="log-out-outline" size={18} color={c.rose} />
            <Text style={s.signOutText}>Sign out</Text>
          </TouchableOpacity>
          <Text style={s.signOutHint}>
            You will need to sign in again to access your account.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function HeroStat({ label, value }) {
  return (
    <View style={styles.heroStat}>
      <Text style={styles.heroStatValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.heroStatLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// Cross-platform elevation. Mirrors HomeScreen: `boxShadow` for web (where
// `shadow*` flattens), native props elsewhere, and the tone comes from the
// palette so a black shadow never sits on a dark canvas.
const shadow = (elevation, shadowOpacity = 0.18, tone = "#000000") =>
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

const useSettingsStyles = (c, topInset) =>
  useMemo(() => buildStyles(c, topInset), [c, topInset]);

// One stylesheet per colour scheme, rebuilt only when the scheme flips. Every
// colour is a palette token, so the page has no light-only code path.
// `topInset` is the Android status-bar height: the app is edge-to-edge there
// (mandatory on Android 16), and this screen draws its own header rather than
// using a navigator header, so it has to inset itself.
const buildStyles = (c, topInset = 0) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.canvas,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingBottom: 40,
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

    /* ---------- Identity hero ---------- */
    hero: {
      borderRadius: 26,
      overflow: "hidden",
      ...shadow(6, 0.2, c.shadow),
    },
    heroGradient: {
      padding: 20,
      gap: 18,
    },
    heroTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    avatar: {
      width: 62,
      height: 62,
      borderRadius: 21,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255, 255, 255, 0.22)",
      borderWidth: 1,
      borderColor: "rgba(255, 255, 255, 0.32)",
    },
    avatarText: {
      fontFamily: fonts.displayBold,
      fontSize: 24,
      color: "#FFFFFF",
      letterSpacing: 0.5,
    },
    heroIdentity: {
      flex: 1,
      alignItems: "flex-start",
    },
    heroName: {
      fontFamily: fonts.display,
      fontSize: 20,
      color: c.heroText,
    },
    heroEmail: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.heroTextDim,
      marginTop: 2,
    },
    heroBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "rgba(0, 0, 0, 0.30)",
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 999,
      marginTop: 8,
    },
    heroBadgeText: {
      fontFamily: fonts.bodyBold,
      fontSize: 10,
      color: "#FFFFFF",
      letterSpacing: 1,
    },
    heroStats: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: "rgba(0, 0, 0, 0.20)",
      borderRadius: 18,
      paddingVertical: 12,
    },
    heroStatDivider: {
      width: StyleSheet.hairlineWidth,
      height: 26,
      backgroundColor: "rgba(255, 255, 255, 0.24)",
    },

    /* ---------- Sections ---------- */
    section: {
      marginTop: 26,
    },
    sectionEyebrow: {
      fontFamily: fonts.bodySemi,
      fontSize: 10,
      color: c.mintDim,
      letterSpacing: 1.4,
      textTransform: "uppercase",
      marginBottom: 10,
      marginLeft: 4,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 6,
      ...shadow(4, 0.16, c.shadow),
    },
    cardDivided: {
      backgroundColor: c.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.hairline,
      overflow: "hidden",
      ...shadow(4, 0.16, c.shadow),
    },

    /* ---------- Rows ---------- */
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 13,
      paddingHorizontal: 12,
    },
    rowBody: {
      flex: 1,
    },
    rowTitle: {
      fontFamily: fonts.bodySemi,
      fontSize: 14.5,
      color: c.textPrimary,
    },
    rowValue: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textSecondary,
      marginTop: 2,
    },
    rowSubtitle: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.hairline,
      marginLeft: 60,
    },
    versionValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 13.5,
      color: c.textSecondary,
    },

    /* ---------- Forms ---------- */
    editForm: {
      marginTop: 12,
      backgroundColor: c.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 18,
      gap: 14,
      ...shadow(4, 0.16, c.shadow),
    },
    editCta: {
      marginTop: 12,
    },
    formTitle: {
      fontFamily: fonts.display,
      fontSize: 17,
      color: c.textPrimary,
    },
    formGap: {
      gap: 14,
    },
    editActions: {
      flexDirection: "row",
      gap: 12,
    },
    flexAction: {
      flex: 1,
    },
    themeBlock: {
      paddingHorizontal: 12,
      paddingTop: 14,
      paddingBottom: 16,
    },

    /* ---------- Sign out ---------- */
    signOutWrap: {
      marginTop: 28,
      gap: 10,
    },
    signOutButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      height: 52,
      borderRadius: 999,
      backgroundColor: `${c.rose}14`,
      borderWidth: 1,
      borderColor: `${c.rose}40`,
    },
    signOutText: {
      fontFamily: fonts.bodyBold,
      fontSize: 14.5,
      color: c.rose,
    },
    signOutHint: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.textMuted,
      textAlign: "center",
    },

    /* ---------- Skeleton ---------- */
    // Wrapped in a SafeAreaView with edges={["top"]}, so the status-bar inset
    // is already applied here - unlike the real header, which has to inset
    // itself. Only the resting gap below the bar belongs in the style.
    skeletonContainer: {
      flex: 1,
      paddingHorizontal: 20,
      paddingTop: 8,
    },
    skeletonHero: {
      height: 150,
      borderRadius: 26,
      backgroundColor: c.skeleton,
      marginBottom: 26,
    },
    skeletonCard: {
      height: 84,
      borderRadius: 22,
      backgroundColor: c.skeleton,
      marginBottom: 16,
      padding: 20,
      justifyContent: "center",
      gap: 10,
    },
    skeletonLineWide: {
      height: 13,
      borderRadius: 7,
      backgroundColor: c.surfaceHover,
      width: "55%",
    },
    skeletonLineNarrow: {
      height: 11,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
      width: "35%",
    },
  });

// Hero stat typography always sits on the gradient, which is light-on-dark in
// both schemes, so these are intentionally scheme-independent.
const styles = StyleSheet.create({
  heroStat: {
    flex: 1,
    alignItems: "center",
  },
  heroStatValue: {
    fontFamily: fonts.displayBold,
    fontSize: 19,
    color: "#FFFFFF",
  },
  heroStatLabel: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    color: "rgba(255, 255, 255, 0.72)",
    marginTop: 2,
  },
});
