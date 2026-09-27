import React, { useState } from "react";
import { Text, TouchableOpacity } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import {
  Field,
  PrimaryButton,
  SecondaryButton,
  useThemedStyles,
} from "../components/ui";
import {
  AuthDivider,
  AuthShell,
  authFooterLink,
  authFooterText,
} from "../components/AuthShell";

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen({ navigation }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { showError } = useNotification();
  const { c, styles } = useThemedStyles();

  const handleLogin = async () => {
    if (!email || !password) {
      showError("Error", "Please fill in all fields");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        console.error("Login error:", error);
        showError("Login Failed", error.message);
      } else if (data.user && !data.user.email_confirmed_at) {
        // Signed in, but the address was never confirmed. Supabase still
        // issues a session here, so this is a warning rather than a block -
        // the previous code had an empty `else` branch with the same intent.
        showError(
          "Email Confirmation Required",
          "Please check your email and confirm your account before signing in.",
        );
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

      // Second arg MUST be the app scheme, not the Supabase callback - this is
      // what lets the deep link return to the app after the browser auth.
      const result = await WebBrowser.openAuthSessionAsync(
        data.url,
        "mystiwanebusiness://",
      );

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
            const { error: sessionError } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
            if (sessionError) throw sessionError;
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
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to manage bundles, orders and your wallet."
      footer={
        <TouchableOpacity
          onPress={() => navigation.navigate("Signup")}
          activeOpacity={0.7}
          accessibilityRole="button"
        >
          <Text style={authFooterText(c)}>
            Don&apos;t have an account?{" "}
            <Text style={authFooterLink(c)}>Sign up</Text>
          </Text>
        </TouchableOpacity>
      }
    >
      <Field
        label="Email"
        icon="mail-outline"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        textContentType="emailAddress"
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
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={handleLogin}
      />

      {/* Right-aligned so it sits under the field it belongs to instead of
          floating in the middle of the form. */}
      <TouchableOpacity
        onPress={() => navigation.navigate("ForgotPassword")}
        activeOpacity={0.7}
        accessibilityRole="button"
        style={{ alignSelf: "flex-end", marginTop: -4 }}
      >
        <Text style={styles.linkText}>Forgot password?</Text>
      </TouchableOpacity>

      <PrimaryButton
        title="Sign in"
        onPress={handleLogin}
        loading={loading}
        disabled={googleLoading}
      />

      <AuthDivider />

      <SecondaryButton
        title={googleLoading ? "Signing in…" : "Continue with Google"}
        icon="logo-google"
        onPress={handleGoogleSignIn}
        style={googleLoading ? { opacity: 0.6 } : null}
      />
    </AuthShell>
  );
}
