import React, { useEffect, useMemo, useState, useRef } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { AppState, Linking, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import Constants from "expo-constants";
import { useFonts } from "expo-font";
import {
  Fraunces_600SemiBold,
  Fraunces_700Bold,
} from "@expo-google-fonts/fraunces";
import {
  PublicSans_400Regular,
  PublicSans_500Medium,
  PublicSans_600SemiBold,
  PublicSans_700Bold,
  PublicSans_800ExtraBold,
} from "@expo-google-fonts/public-sans";
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
import InstallAppBanner from "./src/components/InstallAppBanner";
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
import { ThemeProvider, useTheme } from "./src/contexts/ThemeContext";
import { DockVisibilityProvider } from "./src/contexts/DockVisibilityContext";
import DockTabBar from "./src/components/DockTabBar";
import { DOCK_BAR_HEIGHT, isAuthRoute } from "./src/lib/dockNav";
import { getWebLinking } from "./src/lib/webLinking";

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

/**
 * Hosts the bottom dock. Needs the theme (for the palette) and the visibility
 * context, both of which are provided further up the tree, so it lives in its
 * own component rather than inline in `App`'s return.
 *
 * `NavigationContainer` renders its children into a plain flex column, so the
 * dock's `position: absolute; bottom: 0` resolves against the full screen -
 * which is what we want for a bottom bar.
 *
 * The dock is suppressed on auth routes. It is mounted here, ABOVE the
 * navigator, so it would otherwise draw on every screen a signed-out visitor
 * can reach - putting a four-tab bar and a "More" popup on top of the Login
 * and Signup forms. Gating it here rather than in each auth screen means a
 * future auth route is covered by adding its name to `AUTH_ROUTE_NAMES`, with
 * no per-screen opt-out to forget.
 *
 * `isSignedIn` is a second, independent guard and is what makes sign-out
 * correct. `currentRouteName` only updates when the navigation state CHANGES,
 * so the instant `signOut()` clears the session the route name is still
 * "Profile" - and the dock would hang over the login screen until the
 * navigator settled. The navigator only ever registers auth screens while
 * there is no user, so "no session" implies "auth screen" regardless of what
 * the (possibly stale) route name says.
 */
function DockHost({ navigationRef, currentRouteName, isSignedIn, account }) {
  if (!isSignedIn || isAuthRoute(currentRouteName)) return null;

  return (
    <DockVisibilityProvider>
      <DockTabBar
        navigationRef={navigationRef}
        currentRouteName={currentRouteName}
        account={account}
      />
    </DockVisibilityProvider>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [isAgent, setIsAgent] = useState(false);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const navigationRef = useRef(null);
  // Route name of the focused screen. The dock highlights the matching tab; the
  // app uses a single Stack.Navigator (not tabs), so this has to be tracked off
  // the navigation container rather than read from tab descriptors.
  const [currentRouteName, setCurrentRouteName] = useState(null);

  // Fraunces carries the display voice, Public Sans the UI voice. Loading them
  // before the splash hides avoids a visible reflow on first paint.
  const [fontsLoaded, fontError] = useFonts({
    Fraunces_600SemiBold,
    Fraunces_700Bold,
    PublicSans_400Regular,
    PublicSans_500Medium,
    PublicSans_600SemiBold,
    PublicSans_700Bold,
    PublicSans_800ExtraBold,
  });

  const fontsReady = fontsLoaded || Boolean(fontError);

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
          // `userRole` must be set here too, not just in the auth listener.
          // `getSession()` on a cold start does NOT emit an auth event, so
          // without this the role stays null for the first frames and the dock
          // renders its reduced (normal-user) menu until something else
          // happens to trigger the listener.
          setUserRole(normalizeUserRole(session?.user ?? null));
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
              const refreshedUser = refreshData.session.user;
              setUser(refreshedUser);
              setUserRole(normalizeUserRole(refreshedUser));
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

  /**
   * Re-sync the signed-in user's identity from the server.
   *
   * WHY THIS EXISTS: `supabase.auth.onAuthStateChange` does NOT fire when an
   * admin changes your role in the admin app. That write is a service-role
   * `updateUserById`, and supabase-js has no cross-device push for auth
   * metadata - the running client is never told. Worse, the role that the app
   * reads lives in the ACCESS TOKEN, and `getSession()` returns the cached
   * token, so a promoted/demoted user keeps the role they had at sign-in until
   * that token expires (up to an hour) or the app is killed.
   *
   * `refreshSession()` forces a new token from the auth server, which then
   * emits `TOKEN_REFRESHED` and updates the local `user` object. Call it when
   * the app returns to the foreground - that is the moment a user is most
   * likely to have just been given a new role on another device.
   *
   * Guarded so a backgrounded app or a rapid app-switch does not fire a token
   * request per resume.
   */
  useEffect(() => {
    // Local flag, NOT the `mounted` from the init effect above - that one is
    // a `let` scoped to its own effect body and is not visible here.
    let subscribed = true;
    let lastResumedAt = 0;

    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;

      const now = Date.now();
      if (now - lastResumedAt < 5000) return;
      lastResumedAt = now;

      supabase.auth
        .refreshSession()
        .then(({ data, error }) => {
          if (!subscribed || error || !data?.session) return;
          const refreshedUser = data.session.user;
          setUser(refreshedUser);
          setUserRole(normalizeUserRole(refreshedUser));
        })
        .catch((refreshError) => {
          // A failed refresh is not fatal - the cached session is still valid
          // until it expires, and the user is already signed in. Swallowing it
          // avoids an unhandled rejection on every resume.
          console.error("Session refresh on resume failed:", refreshError);
        });
    });

    return () => {
      subscribed = false;
      subscription?.remove?.();
    };
  }, []);

  const isSignedIn = Boolean(user);

  // What the dock is allowed to show. Derived from the SAME `user` the
  // navigator branches on, so the dock and the hamburger drawer can never
  // disagree about who is a Super Agent or which badge they hold.
  //
  // The badge is read from `app_metadata` first: it is the authoritative store
  // (the user can self-write `user_metadata` via `auth.updateUser()`), and
  // every gated screen already gates on it that way. See roles-and-badges.md.
  const account = {
    isSuperAgent: userRole === "SuperAgent",
    isEnterprise:
      userRole === "SuperAgent" &&
      String(
        user?.app_metadata?.super_agent_badge ||
          user?.user_metadata?.super_agent_badge ||
          "enterprise",
      ).toLowerCase() !== "pro",
  };

  // Web-only linking config. Without it the container never subscribes to
  // `popstate`, so the browser Back button changes the URL without issuing a
  // `GO_BACK` and the stack is stuck on the pushed screen.
  //
  // Gated on web only: the native build already has its own `Linking` handling
  // in the effect above for the password-recovery deep link, and a second
  // config would give the container its own URL listener and compete with it.
  //
  // Deps are on the BOOLEAN, not on `user`. The config's content only changes
  // when the navigator swaps between its auth and app branches, and React
  // Navigation re-subscribes whenever the `linking` object identity changes -
  // so depending on the `user` object itself (which changes identity on every
  // token refresh) would resubscribe for no reason.
  const webLinking = useMemo(
    () => (Platform.OS === "web" ? getWebLinking(isSignedIn) : undefined),
    [isSignedIn],
  );

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
      // Browser push registration is unnecessary for the web app and adds
      // permission/device work during startup.
      if (Platform.OS === "web" || !user) return;

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
        },
      );
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
    const splashCanHide =
      fontsReady && versionChecked && (!canEnterApp || authInitialized);

    if (splashCanHide) {
      SplashScreen.hideAsync().catch(() => {
        // SplashScreen is a no-op on web.
      });
    }
  }, [fontsReady, versionChecked, canEnterApp, authInitialized]);

  return (
    <KeyboardProvider preload={false} statusBarTranslucent>
      <SafeAreaProvider>
        <NotificationProvider>
          <ThemeProvider>
            {canEnterApp && fontsReady ? (
              <NavigationContainer
                ref={navigationRef}
                // Web only. `undefined` on native - see the memo above. This is
                // what makes the browser Back button pop the stack.
                linking={webLinking}
                // The dock highlights whichever tab matches the focused screen,
                // so the route has to be tracked from the container.
                //
                // `onReady` matters as much as `onStateChange`: on the very
                // first render the state does not CHANGE, so without this the
                // route name stays null and the dock renders for a frame over
                // the Login screen before the first navigation corrects it.
                // That flash is visible on cold start, which is exactly when a
                // signed-out user is looking at it.
                onReady={() =>
                  setCurrentRouteName(
                    navigationRef.current?.getCurrentRoute()?.name ?? null,
                  )
                }
                onStateChange={() =>
                  setCurrentRouteName(
                    navigationRef.current?.getCurrentRoute()?.name ?? null,
                  )
                }
              >
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
                {/* Bottom dock, native only. The web build keeps the top-bar
                    overflow menu, so the dock is gated on Platform.OS. It sits
                    inside the container as a sibling of the navigator so it
                    floats over the active screen rather than pushing layout. */}
                {Platform.OS !== "web" ? (
                  <DockHost
                    navigationRef={navigationRef}
                    currentRouteName={currentRouteName}
                    isSignedIn={isSignedIn}
                    account={account}
                  />
                ) : null}
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
            <InstallAppBanner />
          </ThemeProvider>
        </NotificationProvider>
      </SafeAreaProvider>
    </KeyboardProvider>
  );
}
