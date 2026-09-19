import React, { useEffect, useState, useRef } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  View,
  Text,
  TouchableOpacity,
  Linking,
  Platform,
  Animated,
  Image,
  StyleSheet,
} from "react-native";
import * as Notifications from "expo-notifications";
import { supabase } from "./src/lib/supabase";
import { NotificationProvider } from "./src/contexts/NotificationContext";
import { useAppVersion } from "./src/hooks/useAppVersion";
import {
  registerForPushNotifications,
  savePushToken,
  setupNotificationListeners,
} from "./src/services/notifications";
import UpdateNotification from "./src/components/UpdateNotification";
import LoginScreen from "./src/screens/LoginScreen";
import SignupScreen from "./src/screens/SignupScreen";
import ForgotPasswordScreen from "./src/screens/ForgotPasswordScreen";
import ResetPasswordScreen from "./src/screens/ResetPasswordScreen";
import HomeScreen from "./src/screens/HomeScreen";
import AgentDashboardScreen from "./src/screens/AgentDashboardScreen";
import ProfileScreen from "./src/screens/ProfileScreen";
import PrivacyPolicyScreen from "./src/screens/PrivacyPolicyScreen";
import NotificationsScreen from "./src/screens/NotificationsScreen";
import DataScreen from "./src/screens/DataScreen";
import ReceiptScreen from "./src/screens/ReceiptScreen";
import HistoryScreen from "./src/screens/HistoryScreen";
import WalletTopUpScreen from "./src/screens/WalletTopUpScreen";
import SuperAgentManagementScreen from "./src/screens/SuperAgentManagementScreen";
import SuperAgentOffersScreen from "./src/screens/SuperAgentOffersScreen";
import SuperAgentAgentsScreen from "./src/screens/SuperAgentAgentsScreen";
import SuperAgentTierManagementScreen from "./src/screens/SuperAgentTierManagementScreen";
import SuperAgentPaystackScreen from "./src/screens/SuperAgentPaystackScreen";
import colors from "./src/components/theme";

const Stack = createNativeStackNavigator();

const normalizeUserRole = (user) => {
  const role = (user?.user_metadata?.role || user?.app_metadata?.role || "")
    .toString()
    .trim();

  if (!role) return null;

  const normalized = role.toLowerCase();
  if (normalized === "admin") return "Admin";
  if (normalized === "superagent" || normalized === "super_agent")
    return "SuperAgent";
  if (normalized === "agent") return "Agent";

  return role;
};

function SplashLoading() {
  const pulse = useRef(new Animated.Value(0.92)).current;
  const dots = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.92,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );

    const dotsAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(dots, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(dots, {
          toValue: 0.3,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );

    pulseAnimation.start();
    dotsAnimation.start();

    return () => {
      pulseAnimation.stop();
      dotsAnimation.stop();
    };
  }, [pulse, dots]);

  return (
    <View style={styles.splashContainer}>
      <Animated.View
        style={[styles.splashLogoWrap, { transform: [{ scale: pulse }] }]}
      >
        <Image
          source={require("./assets/mystiwan.png")}
          style={styles.splashLogo}
        />
      </Animated.View>
      <Text style={styles.splashTitle}>Mystiwan E-Business</Text>
      <Animated.View style={[styles.splashDots, { opacity: dots }]}>
        <View style={styles.splashDot} />
        <View style={styles.splashDot} />
        <View style={styles.splashDot} />
      </Animated.View>
    </View>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [isAgent, setIsAgent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const navigationRef = useRef(null);
  const {
    versionChecked,
    canEnterApp,
    updateModal,
    setUpdateModal,
    handleDownload,
  } = useAppVersion();

  useEffect(() => {
    let mounted = true;

    const initializeApp = async () => {
      try {
        // Auth initialization only (version check is handled by hook)

        if (!mounted) return;

        // Handle deep linking for password reset
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          handleDeepLink(initialUrl);
        }

        // Simple session check
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();
        console.log(
          "Initial session check:",
          session ? "User logged in" : "No session",
          error,
        );

        if (error) {
          console.error("Session error:", error);
        }

        if (mounted) {
          setUser(session?.user ?? null);
          setAuthInitialized(true);
        }

        // On web, try to refresh the session if we have a session but no user
        if (Platform.OS === "web" && session && !session.user) {
          console.log("Web: Refreshing session...");
          const { data: refreshData, error: refreshError } =
            await supabase.auth.refreshSession();
          if (refreshError) {
            console.error("Session refresh error:", refreshError);
          } else if (refreshData.session) {
            console.log("Session refreshed successfully");
            if (mounted) {
              setUser(refreshData.session.user);
            }
          }
        }
      } catch (error) {
        console.error("App initialization error:", error);
        if (mounted) {
          setUser(null);
          setAuthInitialized(true);
        }
      }
    };

    const handleDeepLink = async (url) => {
      console.log("Handling deep link:", url);
      if (url.includes("access_token") || url.includes("type=recovery")) {
        // Extract tokens from URL (could be in hash or query)
        let params = null;
        if (url.includes("#")) {
          const hash = url.split("#")[1];
          params = new URLSearchParams(hash);
        } else {
          const urlObj = new URL(url);
          params = urlObj.searchParams;
        }
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");
        const type = params.get("type");
        if (accessToken && refreshToken && type === "recovery") {
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (error) {
            console.error("Error setting session from deep link:", error);
          } else {
            console.log("Session set from deep link for password reset");
            if (mounted) {
              setIsResettingPassword(true);
            }
            // Navigate to ResetPasswordScreen after a short delay
            setTimeout(() => {
              if (navigationRef.current) {
                navigationRef.current.navigate("ResetPassword");
              }
            }, 100);
          }
        }
      }
    };

    initializeApp();

    // Listen for deep link URL changes
    const urlListener = Linking.addEventListener("url", (event) => {
      handleDeepLink(event.url);
    });

    // Simple auth state listener
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      console.log("Auth event:", event, session?.user?.email || "No user");

      if (!mounted) return;

      const nextUser = session?.user ?? null;
      const nextRole = normalizeUserRole(nextUser);
      setUser(nextUser);
      setUserRole(nextRole);

      if (event === "PASSWORD_RECOVERY") {
        setIsResettingPassword(true);
      } else if (event === "USER_UPDATED" && isResettingPassword) {
        setIsResettingPassword(false);
      }

      // Check agent status when user changes
      if (session?.user) {
        const nextRole = normalizeUserRole(session.user);
        if (mounted) {
          setUserRole(nextRole);
        }

        supabase
          .from("agent_wallet")
          .select("*")
          .eq("agent_id", session.user.id)
          .single()
          .then(({ data, error }) => {
            if (mounted) {
              const walletExists = !error && data !== null;
              setIsAgent(
                nextRole === "Agent" ||
                  (walletExists && nextRole !== "SuperAgent"),
              );
            }
          })
          .catch(() => {
            if (mounted) setIsAgent(nextRole === "Agent");
          });
      } else {
        if (mounted) setIsAgent(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
      urlListener.remove();
    };
  }, []);

  // Configure notifications on app start
  useEffect(() => {
    // Notifications are configured automatically by the service
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  }, []);

  // Notification setup and token registration
  useEffect(() => {
    let isMounted = true;
    let notificationSubscription = null;

    const setupNotifications = async () => {
      // Only register for push notifications if user is logged in
      if (user) {
        console.log("Registering push notifications for user:", user.id);
        const token = await registerForPushNotifications();
        if (token) {
          await savePushToken(token, user.id);
          console.log("Push notifications registered successfully");
        } else {
          console.log("Push notification registration skipped or failed");
        }

        // Setup notification listeners
        notificationSubscription = setupNotificationListeners(
          (notification) => {
            console.log("Notification received in foreground:", {
              title: notification.request.content.title,
              body: notification.request.content.body,
              data: notification.request.content.data,
            });
          },
          (response) => {
            console.log("Notification tapped:", {
              title: response.notification.request.content.title,
              body: response.notification.request.content.body,
              data: response.notification.request.content.data,
            });
            // TODO: Handle navigation based on notification data type
          },
        );
      }
    };

    setupNotifications();

    return () => {
      isMounted = false;
      if (notificationSubscription) {
        notificationSubscription.remove();
      }
    };
  }, [user]);

  // Set loading to false only when both version is checked and auth is initialized
  useEffect(() => {
    if (versionChecked && authInitialized) {
      setLoading(false);
    }
  }, [versionChecked, authInitialized]);

  if (loading && canEnterApp) {
    return <SplashLoading />;
  }

  return (
    <NotificationProvider>
      {canEnterApp ? (
        <NavigationContainer ref={navigationRef}>
          <Stack.Navigator
            screenOptions={{ headerShown: false }}
            initialRouteName={
              isResettingPassword ? "ResetPassword" : user ? "Home" : "Login"
            }
          >
            {user && !isResettingPassword ? (
              <>
                <Stack.Screen name="Home" component={HomeScreen} />
                <Stack.Screen name="Profile" component={ProfileScreen} />
                <Stack.Screen
                  name="PrivacyPolicy"
                  component={PrivacyPolicyScreen}
                />
                <Stack.Screen
                  name="Notifications"
                  component={NotificationsScreen}
                />
                <Stack.Screen name="Data" component={DataScreen} />
                <Stack.Screen
                  name="SuperAgentManagement"
                  component={SuperAgentManagementScreen}
                />
                <Stack.Screen
                  name="SuperAgentOffers"
                  component={SuperAgentOffersScreen}
                />
                <Stack.Screen
                  name="SuperAgentTierManagement"
                  component={SuperAgentTierManagementScreen}
                />
                <Stack.Screen
                  name="SuperAgentAgents"
                  component={SuperAgentAgentsScreen}
                />
                <Stack.Screen
                  name="SuperAgentPaystack"
                  component={SuperAgentPaystackScreen}
                />
                <Stack.Screen name="Receipt" component={ReceiptScreen} />
                <Stack.Screen name="History" component={HistoryScreen} />
                <Stack.Screen
                  name="WalletTopUp"
                  component={WalletTopUpScreen}
                />
              </>
            ) : (
              <>
                <Stack.Screen name="Login" component={LoginScreen} />
                <Stack.Screen name="Signup" component={SignupScreen} />
                <Stack.Screen
                  name="ForgotPassword"
                  component={ForgotPasswordScreen}
                />
                <Stack.Screen
                  name="ResetPassword"
                  component={ResetPasswordScreen}
                  initialParams={{ isResetting: isResettingPassword }}
                />
              </>
            )}
          </Stack.Navigator>
        </NavigationContainer>
      ) : null}
      <UpdateNotification
        visible={updateModal.visible}
        title={updateModal.title}
        message={updateModal.message}
        downloadUrl={updateModal.downloadUrl}
        releaseNotes={updateModal.releaseNotes}
        onDownload={handleDownload}
      />
    </NotificationProvider>
  );
}

const styles = StyleSheet.create({
  splashContainer: {
    flex: 1,
    backgroundColor: colors.light,
    alignItems: "center",
    justifyContent: "center",
  },
  splashLogoWrap: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 6,
  },
  splashLogo: {
    width: 110,
    height: 110,
    borderRadius: 55,
  },
  splashTitle: {
    marginTop: 20,
    fontSize: 20,
    fontWeight: "700",
    color: colors.primary,
  },
  splashDots: {
    flexDirection: "row",
    marginTop: 14,
  },
  splashDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginHorizontal: 4,
  },
});
