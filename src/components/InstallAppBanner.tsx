import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Image,
  type ImageStyle,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import colors from "./theme";

const APP_NAME = "Mystiwan E-Business";
const DISMISS_KEY = "mystiwan_pwa_banner_dismissed_at";
const NATIVE_DISMISS_KEY = "mystiwan_pwa_native_dismissed_at";
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type InstallMode = "native" | "ios" | null;

const wasRecentlyDismissed = (key: string, delay: number) => {
  const stored = Number(window.localStorage.getItem(key) || 0);
  return stored > 0 && Date.now() - stored < delay;
};

const rememberDismissal = (key: string) => {
  window.localStorage.setItem(key, String(Date.now()));
};

const isIosDevice = () => {
  const userAgent = window.navigator.userAgent;
  const maxTouchPoints = window.navigator.maxTouchPoints || 0;
  const isIpadOs = /Macintosh/.test(userAgent) && maxTouchPoints > 1;
  return (
    /iPhone|iPad/.test(userAgent) ||
    isIpadOs ||
    (window.navigator.platform === "MacIntel" && maxTouchPoints > 1)
  );
};

const isIosSafari = () => {
  const userAgent = window.navigator.userAgent;
  return (
    isIosDevice() &&
    /Safari/.test(userAgent) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent)
  );
};

export default function InstallAppBanner() {
  const [mode, setMode] = useState<InstallMode>(null);
  const [instructionsVisible, setInstructionsVisible] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const animation = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  useEffect(() => {
    if (Platform.OS !== "web") return;

    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const navigatorWithStandalone = window.navigator as Navigator & {
      standalone?: boolean;
    };
    const isInstalled =
      standaloneQuery.matches || navigatorWithStandalone.standalone === true;

    const onInstalled = () => {
      deferredPrompt.current = null;
      setMode(null);
    };
    const onDisplayModeChange = (event: MediaQueryListEvent) => {
      if (event.matches) onInstalled();
    };
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredPrompt.current = event as BeforeInstallPromptEvent;
      if (
        !isInstalled &&
        !wasRecentlyDismissed(DISMISS_KEY, THIRTY_DAYS) &&
        !wasRecentlyDismissed(NATIVE_DISMISS_KEY, SEVEN_DAYS)
      ) {
        setMode("native");
      }
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    standaloneQuery.addEventListener?.("change", onDisplayModeChange);

    // iOS Safari does not fire beforeinstallprompt. Its Add to Home Screen
    // action is available from Safari's Share menu.
    if (
      !isInstalled &&
      isIosSafari() &&
      !wasRecentlyDismissed(DISMISS_KEY, THIRTY_DAYS)
    ) {
      const timer = window.setTimeout(() => setMode("ios"), 1200);
      return () => {
        window.clearTimeout(timer);
        window.removeEventListener(
          "beforeinstallprompt",
          onBeforeInstallPrompt,
        );
        window.removeEventListener("appinstalled", onInstalled);
        standaloneQuery.removeEventListener?.("change", onDisplayModeChange);
      };
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      standaloneQuery.removeEventListener?.("change", onDisplayModeChange);
    };
  }, []);

  useEffect(() => {
    if (!mode) {
      Animated.timing(animation, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
      return;
    }

    Animated.spring(animation, {
      toValue: 1,
      damping: 18,
      stiffness: 150,
      mass: 0.9,
      useNativeDriver: true,
    }).start();
  }, [animation, mode]);

  const dismiss = () => {
    rememberDismissal(DISMISS_KEY);
    deferredPrompt.current = null;
    setMode(null);
  };

  const install = async () => {
    if (mode === "ios") {
      setInstructionsVisible((visible) => !visible);
      return;
    }

    const promptEvent = deferredPrompt.current;
    if (!promptEvent) {
      dismiss();
      return;
    }

    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      deferredPrompt.current = null;

      if (choice.outcome === "accepted") {
        setMode(null);
      } else {
        rememberDismissal(NATIVE_DISMISS_KEY);
        setMode(null);
      }
    } catch {
      rememberDismissal(NATIVE_DISMISS_KEY);
      setMode(null);
    }
  };

  if (Platform.OS !== "web" || !mode) return null;

  const isNarrow = width < 520;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.positioner,
        { position: "fixed" } as any,
        {
          bottom: Math.max(insets.bottom, 16) + 8,
          opacity: animation,
          transform: [
            {
              translateY: animation.interpolate({
                inputRange: [0, 1],
                outputRange: [28, 0],
              }),
            },
          ],
        },
      ]}
    >
      <View
        accessibilityRole="alert"
        accessibilityLabel={`Install ${APP_NAME} for a faster app-like experience`}
        style={[styles.card, isNarrow && styles.cardNarrow]}
      >
        <View style={styles.brandMark} importantForAccessibility="no">
          <Image
            source={require("../../assets/mystiwan.png")}
            style={styles.logo as ImageStyle}
          />
        </View>

        <View style={styles.content}>
          <View style={styles.titleRow}>
            <View style={styles.titleContent}>
              <Text style={styles.eyebrow}>YOUR APP, ONE TAP AWAY</Text>
              <Text style={styles.title}>Install {APP_NAME}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss install app prompt"
              hitSlop={12}
              onPress={dismiss}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name="close" size={20} color={colors.primary} />
            </Pressable>
          </View>

          <Text style={styles.message}>
            {mode === "ios"
              ? "Add this app to your Home Screen for a faster, app-like experience."
              : "Get a faster, app-like experience from your home screen."}
          </Text>

          {mode === "ios" && instructionsVisible ? (
            <View style={styles.instructions} accessibilityLiveRegion="polite">
              {[
                "Tap the Share icon in Safari",
                "Choose “Add to Home Screen”",
                "Tap Add to open Mystiwan",
              ].map((instruction, index) => (
                <View key={instruction} style={styles.instructionRow}>
                  <View style={styles.stepBadge}>
                    <Text style={styles.stepText}>{index + 1}</Text>
                  </View>
                  <Text style={styles.instructionText}>{instruction}</Text>
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                mode === "ios"
                  ? instructionsVisible
                    ? "Hide install instructions"
                    : "Show how to install this app"
                  : `Install ${APP_NAME}`
              }
              onPress={install}
              style={({ pressed }) => [
                styles.installButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Ionicons
                name={
                  mode === "ios" ? "share-outline" : "phone-portrait-outline"
                }
                size={18}
                color={colors.white}
              />
              <Text style={styles.installButtonText}>
                {mode === "ios"
                  ? instructionsVisible
                    ? "Hide Instructions"
                    : "How to Install"
                  : "Install App"}
              </Text>
            </Pressable>
            {mode === "ios" && !instructionsVisible ? (
              <Text style={styles.shareHint}>
                Tap Share → Add to Home Screen
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  positioner: {
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
    alignItems: "center",
    paddingHorizontal: 12,
  },
  card: {
    width: "100%",
    maxWidth: 620,
    flexDirection: "row",
    gap: 14,
    padding: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(0, 103, 105, 0.16)",
    backgroundColor: "rgba(255, 255, 255, 0.98)",
    shadowColor: "#073B3C",
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  cardNarrow: {
    padding: 14,
    borderRadius: 20,
  },
  brandMark: {
    width: 54,
    height: 54,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: colors.tint,
    borderWidth: 1,
    borderColor: "rgba(0, 103, 105, 0.12)",
  },
  logo: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  titleContent: {
    flex: 1,
  },
  eyebrow: {
    color: colors.secondary,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "800",
    letterSpacing: 1.1,
  },
  title: {
    marginTop: 1,
    color: colors.dark,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "800",
  },
  message: {
    marginTop: 4,
    color: "#52646A",
    fontSize: 13,
    lineHeight: 19,
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    backgroundColor: colors.light,
  },
  pressed: {
    opacity: 0.65,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 12,
  },
  installButton: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: colors.primary,
  },
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.985 }],
  },
  installButtonText: {
    color: colors.white,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  shareHint: {
    flexShrink: 1,
    color: colors.secondary,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
  },
  instructions: {
    marginTop: 11,
    gap: 7,
    padding: 11,
    borderRadius: 14,
    backgroundColor: colors.light,
  },
  instructionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  stepBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.tint,
  },
  stepText: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: "800",
  },
  instructionText: {
    flex: 1,
    color: colors.dark,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
});
