import React from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { fonts } from "../components/theme";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";

export default function PrivacyPolicyScreen({ navigation }) {
  const theme = useTheme();
  const c = theme.c;
  // The floating back button is absolutely positioned, so it must clear the
  // Android status bar itself. iOS already spaces this, so Android-only.
  const insets = useSafeAreaInsets();
  const backTop = Platform.OS === "android" ? insets.top + 10 : 50;
  const styles = usePrivacyStyles(c);
  // ThemedScreen already renders a scheme-aware StatusBar; this screen must
  // not re-declare one or it overrides the correct barStyle with a hardcoded
  // value that is unreadable in dark mode.
  return (
    <ThemedScreen style={styles.container}>
      {/* Floating Back Button */}
      <TouchableOpacity
        style={[styles.floatingBackButton, { top: backTop }]}
        onPress={() => navigation.goBack()}
      >
        <View style={styles.backButtonCircle}>
          <Ionicons name="arrow-back" size={24} color={c.mint} />
        </View>
      </TouchableOpacity>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.contentHeader}>
          <Text style={styles.screenTitle}>Privacy Policy</Text>
        </View>
        <Text style={styles.lastUpdated}>Last updated: November 30, 2025</Text>

        <Text style={styles.sectionTitle}>1. Information We Collect</Text>
        <Text style={styles.paragraph}>
          We collect information you provide directly to us, such as when you
          create an account, make a purchase, or contact us for support. This
          may include your name, email address, phone number, and payment
          information.
        </Text>

        <Text style={styles.sectionTitle}>2. How We Use Your Information</Text>
        <Text style={styles.paragraph}>
          We use the information we collect to provide, maintain, and improve
          our services, process transactions, send you technical notices and
          support messages, and respond to your comments and questions.
        </Text>

        <Text style={styles.sectionTitle}>3. Information Sharing</Text>
        <Text style={styles.paragraph}>
          We do not sell, trade, or otherwise transfer your personal information
          to third parties without your consent, except as described in this
          policy or as required by law.
        </Text>

        <Text style={styles.sectionTitle}>4. Data Security</Text>
        <Text style={styles.paragraph}>
          We implement appropriate security measures to protect your personal
          information against unauthorized access, alteration, disclosure, or
          destruction.
        </Text>

        <Text style={styles.sectionTitle}>5. Your Rights</Text>
        <Text style={styles.paragraph}>
          You have the right to access, update, or delete your personal
          information. You can manage your account settings or contact us to
          exercise these rights.
        </Text>

        <Text style={styles.sectionTitle}>6. Changes to This Policy</Text>
        <Text style={styles.paragraph}>
          We may update this privacy policy from time to time. We will notify
          you of any changes by posting the new policy on this page and updating
          the "last updated" date.
        </Text>

        <Text style={styles.sectionTitle}>7. Contact Us</Text>
        <Text style={styles.paragraph}>
          If you have any questions about this privacy policy, please contact us
          at: privacy@expressdata.com
        </Text>
      </ScrollView>
    </ThemedScreen>
  );
}

// Layered on the shared kit: `themedStyles(c)` owns the surface ramp, so this
// file only adds the long-form-document pieces.
const usePrivacyStyles = (c) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    ...base,
    container: { ...base.screen },

    floatingBackButton: {
      position: "absolute",
      left: 20,
      zIndex: 10,
    },
    // Opaque surface rather than a white 90% wash: a translucent circle over
    // the scrolling text would let body copy show through the glyph.
    backButtonCircle: {
      width: 45,
      height: 45,
      borderRadius: 23,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
      justifyContent: "center",
      alignItems: "center",
      elevation: 4,
    },
    contentHeader: {
      marginTop: 90, // Accounts for floating back button
      marginBottom: 10,
    },
    screenTitle: {
      fontFamily: fonts.display,
      fontSize: 28,
      color: c.textPrimary,
    },
    content: {
      flex: 1,
      paddingHorizontal: 20,
    },
    scrollContent: {
      paddingBottom: 40,
    },
    lastUpdated: {
      fontFamily: fonts.body,
      fontSize: 13.5,
      color: c.textMuted,
      marginBottom: 20,
      textAlign: "center",
    },
    sectionTitle: {
      fontFamily: fonts.display,
      fontSize: 18,
      color: c.mint,
      marginTop: 20,
      marginBottom: 10,
    },
    // Body copy is the longest text surface in the app, so it uses the
    // secondary ramp rather than the primary one - the muted step is what
    // keeps a 16px paragraph readable across a full screen of text.
    paragraph: {
      fontFamily: fonts.body,
      fontSize: 15.5,
      color: c.textSecondary,
      lineHeight: 24,
      marginBottom: 15,
    },
  });
};
