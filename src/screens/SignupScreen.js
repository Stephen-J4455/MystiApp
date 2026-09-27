import React, { useMemo, useState } from "react";
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

// Supabase's own minimum. Kept as a constant so the inline hint and the
// submit guard can never disagree.
const MIN_PASSWORD_LENGTH = 6;

/**
 * A deliberately small, non-exhaustive strength read. It is NOT an entropy
 * estimate - it only tells the user whether the password is obviously too
 * short to be safe, which is the one case where pushing back before they sign
 * up is worth it.
 */
const passwordProblem = (value) => {
  if (!value) return null;
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (/^[0-9]+$/.test(value)) {
    return "Add some letters - numbers only are easy to guess";
  }
  return null;
};

export default function SignupScreen({ navigation }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  // Only surfaced once the user has actually typed in the field. Showing
  // "passwords do not match" on a pristine form is noise, and it is the reason
  // inline hints like this usually get ignored.
  const [confirmTouched, setConfirmTouched] = useState(false);
  const { showError, showSuccess } = useNotification();
  const { c } = useThemedStyles();

  const passwordError = useMemo(() => passwordProblem(password), [password]);

  const confirmError = useMemo(() => {
    if (!confirmTouched || !confirmPassword) return null;
    if (confirmPassword === password) return null;
    return "Passwords do not match";
  }, [confirmTouched, confirmPassword, password]);

  const handleSignup = async () => {
    setConfirmTouched(true);

    if (!email || !password || !confirmPassword) {
      showError("Error", "Please fill in all fields");
      return;
    }

    if (password !== confirmPassword) {
      showError("Error", "Passwords do not match");
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      showError(
        "Error",
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.signUp({ email, password });

      if (error) {
        console.error("Signup error:", error);
        showError("Signup Failed", error.message);
      } else {
        showSuccess(
          "Success",
          "Account created successfully! Please check your email for verification link.",
        );
      }
    } catch (error) {
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

      const result = await WebBrowser.openAuthSessionAsync(
        data.url,
        "mystiwanebusiness://",
      );

      if (result.type === "success" && result.url) {
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
      title="Create your account"
      subtitle="Buy data bundles and track every order from one place."
      backLabel="Back to sign in"
      onBack={() => navigation.navigate("Login")}
      footer={
        <TouchableOpacity
          onPress={() => navigation.navigate("Login")}
          activeOpacity={0.7}
          accessibilityRole="button"
        >
          <Text style={authFooterText(c)}>
            Already have an account?{" "}
            <Text style={authFooterLink(c)}>Sign in</Text>
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
        placeholder="At least 6 characters"
        secureTextEntry={!showPassword}
        affix={showPassword ? "eye-off-outline" : "eye-outline"}
        onAffixPress={() => setShowPassword((v) => !v)}
        error={passwordError}
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Field
        label="Confirm password"
        icon="shield-checkmark-outline"
        value={confirmPassword}
        onChangeText={(text) => {
          setConfirmPassword(text);
          setConfirmTouched(true);
        }}
        placeholder="Re-enter your password"
        secureTextEntry={!showConfirmPassword}
        affix={showConfirmPassword ? "eye-off-outline" : "eye-outline"}
        onAffixPress={() => setShowConfirmPassword((v) => !v)}
        error={confirmError}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        onSubmitEditing={handleSignup}
      />

      <PrimaryButton
        title="Create account"
        onPress={handleSignup}
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
