import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  StatusBar,
  ScrollView,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import {
  useThemedStyles,
  Field,
  PrimaryButton,
  SecondaryButton,
} from "../components/ui";
import { fonts } from "../components/theme";
WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen({ navigation }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { showError } = useNotification();
  const { c, isDark, styles } = useThemedStyles();

  const handleLogin = async () => {
    if (!email || !password) {
      showError("Error", "Please fill in all fields");
      return;
    }

    setLoading(true);
    try {
      console.log("Attempting login for:", email);
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        console.error("Login error:", error);
        showError("Login Failed", error.message);
      } else {
        console.log("Login successful:", data);
        console.log("User:", data.user);
        console.log("Session:", data.session);

        // On web, check if email confirmation is required
        if (data.user && !data.user.email_confirmed_at) {
          console.log("Email not confirmed, user needs to confirm email");
          showError(
            "Email Confirmation Required",
            "Please check your email and confirm your account before signing in.",
          );
        } else {
          console.log("Login complete, auth state should change");
        }
      }
    } catch (error) {
      console.error("Login exception:", error);
      showError("Error", "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo:
            "https://sffgznknlmqxtikkyhwu.supabase.co/auth/v1/callback",
          skipBrowserRedirect: false,
        },
      });
      if (error) throw error;
      if (!data?.url) throw new Error("No OAuth URL returned from Supabase");

      console.log("Opening Google OAuth URL...");
      // Second arg MUST be the app scheme, not the Supabase callback - this is
      // what lets the deep link return to the app after the browser auth.
      const result = await WebBrowser.openAuthSessionAsync(
        data.url,
        "mystiwanebusiness://",
      );
      console.log("WebBrowser result:", result.type);

      if (result.type === "success" && result.url) {
        // Supabase returns tokens in the fragment on native and the query
        // string on web, so both shapes have to be handled.
        let params = null;
        if (result.url.includes("#")) {
          params = new URLSearchParams(result.url.split("#")[1]);
        } else if (result.url.includes("?")) {
          params = new URLSearchParams(result.url.split("?")[1]);
        }
        if (params) {
          const accessToken = params.get("access_token");
          const refreshToken = params.get("refresh_token");
          if (accessToken && refreshToken) {
            console.log("Setting OAuth session...");
            const { error: sessionError } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
            if (sessionError) throw sessionError;
            console.log("OAuth session set successfully");
            return;
          }
        }
      } else if (result.type === "cancel") {
        showError("Cancelled", "Google sign-in was cancelled");
      }
    } catch (error) {
      console.error("Google sign-in error:", error);
      showError("Error", error.message || "Failed to sign in with Google");
    }
    setGoogleLoading(false);
  };

  return (
    <View style={styles.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <ScrollView
            contentContainerStyle={s.body}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={s.logoWrap}>
              <Image
                source={require("../../assets/mystiwan.png")}
                style={s.logo}
                resizeMode="contain"
              />
            </View>

            <Text style={[s.title, { color: c.textPrimary }]}>
              Welcome Back
            </Text>
            <Text style={[s.subtitle, { color: c.textMuted }]}>
              Sign in to your account
            </Text>

            <View style={s.form}>
              <Field
                label="Email"
                icon="mail-outline"
                value={email}
                onChangeText={setEmail}
                placeholder="Enter your email"
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Field
                label="Password"
                icon="lock-closed-outline"
                value={password}
                onChangeText={setPassword}
                placeholder="Enter your password"
                secureTextEntry={!showPassword}
                affix={showPassword ? "eye-off-outline" : "eye-outline"}
                onAffixPress={() => setShowPassword((v) => !v)}
              />

              <PrimaryButton
                title={loading ? "Signing In..." : "Sign In"}
                onPress={handleLogin}
                loading={loading}
                disabled={googleLoading}
              />

              <TouchableOpacity
                onPress={() => navigation.navigate("ForgotPassword")}
                style={s.forgotWrap}
                activeOpacity={0.7}
              >
                <Text style={styles.linkText}>Forgot Password?</Text>
              </TouchableOpacity>
            </View>

            <View style={s.dividerRow}>
              <View style={styles.divider} />
              <Text style={[s.dividerText, { color: c.textMuted }]}>OR</Text>
              <View style={styles.divider} />
            </View>

            <SecondaryButton
              title={googleLoading ? "Signing in..." : "Continue with Google"}
              icon="logo-google"
              onPress={handleGoogleSignIn}
              style={googleLoading ? s.dimmed : null}
            />

            <TouchableOpacity
              onPress={() => navigation.navigate("Signup")}
              style={s.signupWrap}
              activeOpacity={0.7}
            >
              <Text style={[s.signupText, { color: c.textSecondary }]}>
                Don't have an account?{" "}
                <Text style={styles.linkText}>Sign Up</Text>
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

// Layout only. Every colour comes from the themed stylesheet so this screen
// follows the system scheme without a second code path.
const s = StyleSheet.create({
  body: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 28,
  },
  logoWrap: {
    alignItems: "center",
    marginBottom: 24,
    marginTop: 10,
  },
  logo: {
    width: 92,
    height: 92,
    borderRadius: 28,
  },
  title: {
    fontFamily: fonts.displayBold,
    fontSize: 30,
    marginBottom: 5,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    marginBottom: 26,
  },
  form: {
    gap: 16,
  },
  forgotWrap: {
    alignSelf: "center",
    paddingVertical: 4,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 22,
  },
  dividerText: {
    fontFamily: fonts.bodySemi,
    fontSize: 11.5,
    letterSpacing: 1,
  },
  dimmed: {
    opacity: 0.6,
  },
  signupWrap: {
    alignItems: "center",
    marginTop: 20,
  },
  signupText: {
    fontFamily: fonts.body,
    fontSize: 13.5,
  },
});
