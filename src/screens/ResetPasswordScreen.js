import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StatusBar,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import colors from "../components/theme";
import { useNotification } from "../contexts/NotificationContext";

export default function ResetPasswordScreen({ navigation }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const { showError, showSuccess } = useNotification();

  const handleResetPassword = async () => {
    if (!password || !confirmPassword) {
      showError("Error", "Please fill in all fields");
      return;
    }

    if (password.length < 6) {
      showError("Error", "Password must be at least 6 characters");
      return;
    }

    if (password !== confirmPassword) {
      showError("Error", "Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      // Validate session first
      setStatusMessage("Validating session...");
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession();

      if (sessionError) {
        throw new Error(`Session error: ${sessionError.message}`);
      }

      if (!sessionData?.session) {
        throw new Error(
          "No active session found. Please request a new password reset link."
        );
      }

      // Update password
      setStatusMessage("Updating password...");
      const { data: updateData, error } = await supabase.auth.updateUser({
        password: password,
      });

      if (error) {
        throw new Error(error.message || "Failed to update password");
      }

      if (!updateData?.user) {
        throw new Error("Password update returned no user data.");
      }

      showSuccess(
        "Password Updated",
        "Your password has been successfully reset"
      );

      setStatusMessage("Success! Redirecting...");

      // Clear form
      setPassword("");
      setConfirmPassword("");

      // Navigate after a short delay
      setTimeout(() => {
        setLoading(false);
        setStatusMessage("");
        // Navigation will be handled by auth state change
      }, 1000);
    } catch (error) {
      console.error("Password reset error:", error);
      const errorMessage = error.message || "An unexpected error occurred";
      showError("Password Reset Failed", errorMessage);

      if (errorMessage.includes("session")) {
        setStatusMessage("Session expired. Please request a new reset link.");
      } else {
        setStatusMessage(`Error: ${errorMessage}`);
      }

      setLoading(false);

      // Clear error message after 5 seconds
      setTimeout(() => {
        setStatusMessage("");
      }, 5000);
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
        <View style={styles.content}>
          <Image
            source={require("../../assets/mystiwan.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>Reset Password</Text>
          <Text style={styles.subtitle}>Enter your new password below</Text>

          <View style={styles.inputContainer}>
            <Text style={styles.label}>New Password</Text>
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
                placeholder="Enter new password"
                placeholderTextColor={colors.secondary}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity
                onPress={() => setShowPassword(!showPassword)}
                style={styles.eyeIcon}
              >
                <Ionicons
                  name={showPassword ? "eye-outline" : "eye-off-outline"}
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
                placeholder="Confirm new password"
                placeholderTextColor={colors.secondary}
                secureTextEntry={!showConfirmPassword}
              />
              <TouchableOpacity
                onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                style={styles.eyeIcon}
              >
                <Ionicons
                  name={showConfirmPassword ? "eye-outline" : "eye-off-outline"}
                  size={20}
                  color={colors.secondary}
                />
              </TouchableOpacity>
            </View>
          </View>

          <TouchableOpacity
            style={styles.button}
            onPress={handleResetPassword}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Update Password</Text>
            )}
          </TouchableOpacity>

          {statusMessage ? (
            <Text style={styles.statusMessage}>{statusMessage}</Text>
          ) : null}

          <TouchableOpacity onPress={() => navigation.navigate("Login")}>
            <Text style={styles.link}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light,
  },
  content: {
    flex: 1,
    padding: 20,
    justifyContent: "center",
  },
  logo: {
    width: 120,
    height: 120,
    alignSelf: "center",
    marginBottom: 20,
    borderRadius: 60,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    color: colors.primary,
    textAlign: "center",
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: colors.secondary,
    textAlign: "center",
    marginBottom: 40,
    lineHeight: 24,
  },
  inputContainer: {
    marginBottom: 20,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.primary,
    marginBottom: 8,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.tint,
    borderRadius: 25,
    paddingHorizontal: 15,
    backgroundColor: "#fff",
  },
  inputIcon: {
    marginRight: 10,
  },
  inputWithIcon: {
    flex: 1,
    paddingVertical: 15,
    fontSize: 16,
    color: colors.text,
  },
  eyeIcon: {
    padding: 5,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 25,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 10,
  },
  buttonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
  link: {
    color: colors.primary,
    fontSize: 16,
    textAlign: "center",
    marginTop: 20,
  },
  statusMessage: {
    marginTop: 15,
    padding: 10,
    borderRadius: 8,
    backgroundColor: colors.light,
    textAlign: "center",
    color: colors.secondary,
    fontSize: 14,
  },
});
