import React, { useState } from "react";
import { Text, TouchableOpacity } from "react-native";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { Field, PrimaryButton, useThemedStyles } from "../components/ui";
import {
  AuthShell,
  authFooterLink,
  authFooterText,
} from "../components/AuthShell";

export default function ForgotPasswordScreen({ navigation }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  // Once the request is sent the screen stops being a form: the only useful
  // next step is "check your inbox", and leaving a live field and button above
  // that message invites the user to submit again for no reason.
  const [sent, setSent] = useState(false);
  const { showError, showSuccess } = useNotification();
  const { c } = useThemedStyles();

  const handleResetPassword = async () => {
    if (!email.trim()) {
      showError("Error", "Please enter your email address");
      return;
    }

    setLoading(true);
    try {
      // Redirect to the web page that handles both mobile app and web reset.
      // Vercel injects this value at build time; native builds fall back to the
      // public Vercel URL.
      const redirectUrl = process.env.EXPO_PUBLIC_WEB_URL
        ? `${process.env.EXPO_PUBLIC_WEB_URL.replace(/\/$/, "")}/reset-password.html`
        : "https://your-vercel-domain.example/reset-password.html";

      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: redirectUrl },
      );

      if (error) {
        showError("Error", error.message);
      } else {
        setSent(true);
        showSuccess(
          "Reset Email Sent",
          "Check your email for password reset instructions",
        );
      }
    } catch (error) {
      showError("Error", "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <AuthShell
        title="Check your inbox"
        subtitle={`We sent a reset link to ${email.trim()}. The link expires shortly, so use it soon.`}
        footer={
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={authFooterText(c)}>
              Didn&apos;t get it?{" "}
              <Text style={authFooterLink(c)}>Back to sign in</Text>
            </Text>
          </TouchableOpacity>
        }
      >
        <PrimaryButton
          title="Back to sign in"
          onPress={() => navigation.goBack()}
          icon="arrow-back"
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter the email on your account and we will send you a link to choose a new password."
      backLabel="Back to sign in"
      onBack={() => navigation.goBack()}
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
        returnKeyType="go"
        onSubmitEditing={handleResetPassword}
      />

      <PrimaryButton
        title="Send reset link"
        onPress={handleResetPassword}
        loading={loading}
      />
    </AuthShell>
  );
}
