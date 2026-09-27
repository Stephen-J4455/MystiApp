import React from "react";
import {
  View,
  Text,
  Image,
  ScrollView,
  StatusBar,
  StyleSheet,
  Platform,
  TouchableOpacity,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { fonts } from "./theme";
import { useThemedStyles } from "./ui";

// ===========================================================================
// Shared auth shell
// ===========================================================================
// WHY THIS EXISTS
// ---------------
// Login, Signup and Forgot Password were three separate screen files that each
// hand-rolled the same page: a logo, a display title, a subtitle, a form, and
// a footer link. Two of the three were still reading the LEGACY `colors`
// palette, which has no light/dark variants at all - so "include dark mode"
// was not a matter of adding a few tokens, it meant those two screens could
// not render in dark under any circumstance.
//
// With this shell, the frame exists once. A screen supplies only its copy and
// its form, and inherits the theme automatically because every colour below
// comes from the palette rather than a literal.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// There is no theme switcher on these screens. The `ThemePicker` lives on
// Settings only - that is an explicit product decision (see theming-system.md),
// and login is the wrong place for it: the user cannot set a preference before
// they can sign in, and re-adding it here regresses a deliberate choice.
//
// The gradient is the app's own `heroFrom -> heroTo` ramp, so the auth pages
// read as part of the same product as Home rather than as a separate app. It
// is a 2-stop gradient with no `locations` and the canvas sits behind it, for
// the Android-renderer reason recorded in home-screen-design-system.md: a
// dropped gradient stop must degrade to "plain canvas", never to "unreadable".

/**
 * @param {object} props
 * @param {string} props.title      Display headline.
 * @param {string} props.subtitle   Supporting line under the headline.
 * @param {string} [props.backLabel] Renders a back affordance when provided.
 * @param {() => void} [props.onBack]
 * @param {React.ReactNode} props.children  The form / actions.
 * @param {React.ReactNode} [props.footer]  Bottom link row.
 */
export function AuthShell({
  title,
  subtitle,
  backLabel,
  onBack,
  children,
  footer,
}) {
  const { c, isDark } = useThemedStyles();

  return (
    <View style={[s.root, { backgroundColor: c.canvas }]}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      {/* Brand band. The canvas paints the root, so if the gradient fails to
          render the sheet still sits on a themed background rather than on
          whatever the OS default was. */}
      <LinearGradient
        colors={[c.heroFrom, c.heroTo]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[
          s.band,
          { paddingTop: 34 + (Platform.OS === "android" ? 24 : 0) },
        ]}
      >
        <View style={s.bandGlow} pointerEvents="none">
          <LinearGradient
            colors={[c.heroGlow, "transparent"]}
            style={s.glowFill}
          />
        </View>

        <View style={s.bandInner}>
          {onBack ? <TouchableBack label={backLabel} onPress={onBack} /> : null}

          <Image
            source={require("../../assets/mystiwan.png")}
            style={s.logo}
            resizeMode="contain"
          />

          <View style={s.brandText}>
            <Text style={s.brand} numberOfLines={1}>
              Mystiwan
            </Text>
            <Text style={s.brandTag} numberOfLines={1}>
              Data bundles, delivered
            </Text>
          </View>
        </View>
      </LinearGradient>

      <SafeAreaView style={s.sheet} edges={["bottom"]}>
        <KeyboardAvoidingView
          style={s.sheetFlex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={s.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <Text style={[s.title, { color: c.textPrimary }]}>{title}</Text>
            {subtitle ? (
              <Text style={[s.subtitle, { color: c.textMuted }]}>
                {subtitle}
              </Text>
            ) : null}

            <View style={s.form}>{children}</View>

            {footer ? <View style={s.footer}>{footer}</View> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

function TouchableBack({ label, onPress }) {
  // A real TouchableOpacity, not a `<Text onPress>`. The text form is not
  // reliably focusable or reachable by keyboard/screen reader on native, and
  // `suppressHighlighting` is web-only - the back control is the one thing on
  // these screens a keyboard user must be able to reach.
  return (
    <View style={s.backSlot}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={s.back}
      >
        <Ionicons name="arrow-back" size={15} color="#FFFFFF" />
        <Text style={s.backText}>{label}</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * Centred "or" rule. Lives here so all three auth screens draw the same one.
 */
export function AuthDivider({ children = "or" }) {
  const { c } = useThemedStyles();
  return (
    <View style={s.dividerRow}>
      <View style={[s.dividerLine, { backgroundColor: c.hairline }]} />
      <Text style={[s.dividerText, { color: c.textMuted }]}>{children}</Text>
      <View style={[s.dividerLine, { backgroundColor: c.hairline }]} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
  },
  // The gradient sits directly on the root, whose backgroundColor is set by the
  // caller via a themed wrapper. Keeping the band opaque means a dropped
  // gradient stop still shows a solid brand colour rather than the canvas.
  band: {
    paddingHorizontal: 22,
    paddingBottom: 26,
    borderBottomLeftRadius: 30,
    borderBottomRightRadius: 30,
    overflow: "hidden",
  },
  bandGlow: {
    position: "absolute",
    top: -70,
    right: -50,
    width: 230,
    height: 230,
  },
  glowFill: {
    flex: 1,
    borderRadius: 115,
  },
  bandInner: {
    alignItems: "center",
    gap: 10,
  },
  backSlot: {
    alignSelf: "flex-start",
    marginBottom: 4,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  backText: {
    fontFamily: fonts.bodySemi,
    fontSize: 13.5,
    color: "#FFFFFF",
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 20,
  },
  brandText: {
    alignItems: "center",
  },
  brand: {
    fontFamily: fonts.displayBold,
    fontSize: 24,
    color: "#FFFFFF",
    letterSpacing: -0.3,
  },
  brandTag: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    color: "rgba(255, 255, 255, 0.82)",
    marginTop: 1,
  },

  sheet: {
    flex: 1,
  },
  sheetFlex: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 28,
  },
  title: {
    fontFamily: fonts.displayBold,
    fontSize: 26,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: 20,
    marginTop: 6,
    marginBottom: 22,
  },
  form: {
    gap: 15,
  },
  footer: {
    marginTop: 22,
    alignItems: "center",
  },

  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 4,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontFamily: fonts.bodySemi,
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
});

/**
 * Text styles for the `footer` slot, exported because the three screens each
 * render their own link row and all three need the same two styles. Exported
 * from here rather than from the shared ramp in `ui.js`: the ramp is the
 * app-wide kit, and these are meaningless outside the auth shell.
 */
export const authFooterText = (c) => ({
  fontFamily: fonts.body,
  fontSize: 13.5,
  color: c.textSecondary,
});

export const authFooterLink = (c) => ({
  fontFamily: fonts.bodySemi,
  fontSize: 13.5,
  color: c.mint,
});
