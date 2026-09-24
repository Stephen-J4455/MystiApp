import React, { useEffect, useState, useRef } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Linking, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import Constants from "expo-constants";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
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
import SuperAgentAnalyticsScreen from "./src/screens/SuperAgentAnalyticsScreen";
import SuperAgentHeldOrdersScreen from "./src/screens/SuperAgentHeldOrdersScreen";
import AfaRegistrationScreen from "./src/screens/AfaRegistrationScreen";

SplashScreen.preventAutoHideAsync().catch(() => {
  // The splash module is unavailable on web.
});

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
  if (normalized === "agent" || normalized === "sub_agent") return "Agent";

  return role;
};

export default function App() {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [isAgent, setIsAgent] = useState(false);
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

      // Check agent status when user changes. Sub-agents no longer use wallets.
      if (session?.user) {
        const nextRole = normalizeUserRole(session.user);
        if (mounted) {
          setUserRole(nextRole);
          setIsAgent(nextRole === "Agent");
        }
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
          const saved = await savePushToken(token, user.id);
          if (saved) {
            console.log("Push notifications registered successfully");
          } else {
            console.error(
              "Push token was obtained but could not be saved. Check user_push_tokens permissions.",
            );
          }
        } else {
          const isExpoGo = Constants?.appOwnership === "expo";
          console.log(
            isExpoGo
              ? "Push notification registration skipped: running in Expo Go (push notifications require a standalone build)"
              : "Push notification registration skipped or failed: check console for details",
          );
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

  // Keep Expo's native splash visible until the app is ready to render.
  useEffect(() => {
    const splashCanHide = versionChecked && (!canEnterApp || authInitialized);

    if (splashCanHide) {
      SplashScreen.hideAsync().catch(() => {
        // SplashScreen is a no-op on web.
      });
    }
  }, [versionChecked, canEnterApp, authInitialized]);

  return (
    <KeyboardProvider preload={false} statusBarTranslucent>
      <SafeAreaProvider>
        <NotificationProvider>
          {canEnterApp ? (
            <NavigationContainer ref={navigationRef}>
              <Stack.Navigator
                screenOptions={{ headerShown: false }}
                initialRouteName={
                  isResettingPassword
                    ? "ResetPassword"
                    : user
                      ? "Home"
                      : "Login"
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
                    <Stack.Screen
                      name="SuperAgentAnalytics"
                      component={SuperAgentAnalyticsScreen}
                    />
                    <Stack.Screen
                      name="SuperAgentHeldOrders"
                      component={SuperAgentHeldOrdersScreen}
                    />
                    <Stack.Screen name="Receipt" component={ReceiptScreen} />
                    <Stack.Screen name="History" component={HistoryScreen} />
                    <Stack.Screen
                      name="WalletTopUp"
                      component={WalletTopUpScreen}
                    />
                    <Stack.Screen
                      name="AfaRegistration"
                      component={AfaRegistrationScreen}
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
      </SafeAreaProvider>
    </KeyboardProvider>
  );
}
