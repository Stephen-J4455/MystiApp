import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StatusBar,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "../lib/supabase";
import colors from "../components/theme";
import { useNotification } from "../contexts/NotificationContext";

WebBrowser.maybeCompleteAuthSession();

export default function SignupScreen({ navigation }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { showError, showSuccess } = useNotification();

  const handleSignup = async () => {
    if (!email || !password || !confirmPassword) {
      showError("Error", "Please fill in all fields");
      return;
    }

    if (password !== confirmPassword) {
      showError("Error", "Passwords do not match");
      return;
    }

    if (password.length < 6) {
      showError("Error", "Password must be at least 6 characters");
      return;
    }

    setLoading(true);
    try {
      console.log("Attempting signup for:", email);
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      });

      if (error) {
        console.error("Signup error:", error);
        showError("Signup Failed", error.message);
      } else {
        console.log("Signup successful:", data);
        showSuccess(
          "Success",
          "Account created successfully! Please check your email for verification link."
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
          redirectTo: "https://sffgznknlmqxtikkyhwu.supabase.co/auth/v1/callback",
          skipBrowserRedirect: false,
        },
      });

      if (error) throw error;

      if (data?.url) {
        console.log("Opening Google OAuth URL...");
        const result = await WebBrowser.openAuthSessionAsync(
          data.url,
          "mystiwanebusiness://"
        );

        if (result.type === "success" && result.url) {
          let params = null;
          if (result.url.includes("#")) {
            const hash = result.url.split("#")[1];
            params = new URLSearchParams(hash);
          } else if (result.url.includes("?")) {
            const query = result.url.split("?")[1];
            params = new URLSearchParams(query);
          }

          if (params) {
            const accessToken = params.get("access_token");
            const refreshToken = params.get("refresh_token");

            if (accessToken && refreshToken) {
              const { error: sessionError } =
                await supabase.auth.setSession({
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
        setGoogleLoading(false);
      } else {
        throw new Error("No OAuth URL returned from Supabase");
      }
    } catch (error) {
      console.error("Google sign-in error:", error);
      showError("Error", error.message || "Failed to sign in with Google");
      setGoogleLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="dark-content"
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.content}>
            <Image
              source={require("../../assets/mystiwan.png")}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.title}>Create Account</Text>
            <Text style={styles.subtitle}>Join ExpressData</Text>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Email</Text>
              <View style={styles.inputWrapper}>
                <Ionicons
                  name="mail-outline"
                  size={20}
                  color={colors.secondary}
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.inputWithIcon}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Enter your email"
                  placeholderTextColor={colors.secondary}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputWrapper}>
                <Ionicons
                  name="lock-closed-outline"
                  size={20}
                  color={colors.secondary}
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.inputWithIcon}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Enter your password"
                  placeholderTextColor={colors.secondary}
                  secureTextEntry={!showPassword}
                />
                <TouchableOpacity
                  style={styles.eyeIcon}
                  onPress={() => setShowPassword(!showPassword)}
                >
                  <Ionicons
                    name={showPassword ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color={colors.secondary}
                  />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Confirm Password</Text>
              <View style={styles.inputWrapper}>
                <Ionicons
                  name="lock-closed-outline"
                  size={20}
                  color={colors.secondary}
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.inputWithIcon}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="Confirm your password"
                  placeholderTextColor={colors.secondary}
                  secureTextEntry={!showConfirmPassword}
                />
                <TouchableOpacity
                  style={styles.eyeIcon}
                  onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  <Ionicons
                    name={
                      showConfirmPassword ? "eye-off-outline" : "eye-outline"
                    }
                    size={20}
                    color={colors.secondary}
                  />
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity
              style={styles.button}
              onPress={handleSignup}
              disabled={loading}
            >
              <Text style={styles.buttonText}>
                {loading ? "Creating Account..." : "Sign Up"}
              </Text>
            </TouchableOpacity>

            <View style={styles.dividerContainer}>
              <View style={styles.divider} />
              <Text style={styles.dividerText}>OR</Text>
              <View style={styles.divider} />
            </View>

            <TouchableOpacity
              style={[styles.googleButton, googleLoading && { opacity: 0.6 }]}
              onPress={handleGoogleSignIn}
              disabled={googleLoading || loading}>
              {googleLoading ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <>
                  <Ionicons
                    name="logo-google"
                    size={20}
                    color={colors.primary}
                    style={styles.googleIcon}
                  />
                  <Text style={styles.googleButtonText}>
                    Continue with Google
                  </Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={() => navigation.navigate("Login")}>
              <Text style={styles.link}>Already have an account? Sign In</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.white,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
  },
  logo: {
    width: 120,
    height: 120,
    alignSelf: "center",
    marginBottom: 30,
    borderRadius: 60,
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    color: colors.dark,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: colors.dark,
    opacity: 0.5,
    textAlign: "center",
    marginBottom: 40,
    marginTop: 8,
  },
  inputContainer: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.dark,
    marginBottom: 8,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    backgroundColor: colors.light,
  },
  inputIcon: {
    paddingLeft: 18,
  },
  inputWithIcon: {
    flex: 1,
    padding: 16,
    fontSize: 16,
    color: colors.dark,
    fontWeight: "500",
  },
  eyeIcon: {
    paddingRight: 18,
  },
  button: {
    backgroundColor: colors.primary,
    paddingVertical: 18,
    borderRadius: 20,
    alignItems: "center",
    marginTop: 10,
    elevation: 4,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  buttonText: {
    color: colors.white,
    fontSize: 18,
    fontWeight: "800",
  },
  link: {
    color: colors.dark,
    opacity: 0.6,
    textAlign: "center",
    marginTop: 30,
    fontSize: 15,
    fontWeight: "600",
  },
  dividerContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 30,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerText: {
    marginHorizontal: 15,
    color: colors.dark,
    opacity: 0.3,
    fontSize: 13,
    fontWeight: "700",
  },
  googleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.white,
    paddingVertical: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 10,
  },
  googleIcon: {
    marginRight: 12,
  },
  googleButtonText: {
    color: colors.dark,
    fontSize: 16,
    fontWeight: "700",
  },
});
