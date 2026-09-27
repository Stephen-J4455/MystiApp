import React, { useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  Platform,
  StatusBar,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../contexts/ThemeContext";
import { fonts } from "./theme";

/**
 * Shared, theme-aware building blocks.
 *
 * These exist because every screen was previously hand-rolling the same
 * screen/header/card/field/button markup with hardcoded colours. Screens read
 * the palette from `useTheme()` and pass it down, so converting a screen to
 * light/dark is mostly deleting colour literals.
 */

export const themedStyles = (c, shadow) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.canvas,
    },
    // Scrollable page body with consistent gutters.
    body: {
      flexGrow: 1,
      paddingHorizontal: 20,
      paddingBottom: 32,
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
    },

    /* ---------- Header ---------- */
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 18,
    },
    backButton: {
      width: 40,
      height: 40,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    headerTextWrap: {
      flex: 1,
    },
    headerTitle: {
      fontFamily: fonts.display,
      fontSize: 21,
      color: c.textPrimary,
    },
    headerSubtitle: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textMuted,
      marginTop: 2,
    },
    headerAction: {
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
    },
    headerActionText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.mint,
    },

    /* ---------- Sections ---------- */
    section: {
      marginTop: 26,
    },
    sectionEyebrow: {
      fontFamily: fonts.bodySemi,
      fontSize: 10,
      color: c.mintDim,
      letterSpacing: 1.4,
      textTransform: "uppercase",
      marginBottom: 6,
    },
    sectionTitle: {
      fontFamily: fonts.display,
      fontSize: 20,
      color: c.textPrimary,
      marginBottom: 12,
    },

    /* ---------- Card ---------- */
    card: {
      backgroundColor: c.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 16,
      ...(shadow ? shadow(4, 0.18, c.shadow) : {}),
    },
    cardDivided: {
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.hairline,
      overflow: "hidden",
      backgroundColor: c.surface,
    },

    /* ---------- Rows ---------- */
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    rowDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.hairline,
      marginLeft: 56,
    },
    rowIcon: {
      width: 36,
      height: 36,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    rowBody: {
      flex: 1,
    },
    rowTitle: {
      fontFamily: fonts.bodySemi,
      fontSize: 14.5,
      color: c.textPrimary,
    },
    rowSubtitle: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    rowValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.textSecondary,
    },

    /* ---------- Forms ---------- */
    label: {
      fontFamily: fonts.bodySemi,
      fontSize: 11.5,
      color: c.textSecondary,
      letterSpacing: 0.3,
      marginBottom: 7,
    },
    field: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.hairline,
      paddingHorizontal: 14,
      height: 52,
    },
    fieldFocused: {
      borderColor: c.mintDim,
    },
    fieldIcon: {
      marginRight: 2,
    },
    input: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 15,
      color: c.textPrimary,
      // Android adds its own vertical padding that misaligns the row.
      paddingVertical: 0,
    },
    inputAffix: {
      padding: 4,
    },
    inputAffixIcon: {
      fontSize: 18,
      color: c.textMuted,
    },
    fieldError: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.rose,
      marginTop: 6,
      marginLeft: 2,
    },

    /* ---------- Buttons ---------- */
    primaryButton: {
      height: 52,
      borderRadius: 999,
      backgroundColor: c.mint,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 8,
    },
    primaryButtonDisabled: {
      opacity: 0.55,
    },
    primaryButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 15,
      color: c.onAccent,
    },
    secondaryButton: {
      height: 52,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 8,
      backgroundColor: "transparent",
    },
    secondaryButtonText: {
      fontFamily: fonts.bodySemi,
      fontSize: 15,
      color: c.textPrimary,
    },
    linkText: {
      fontFamily: fonts.bodySemi,
      fontSize: 13.5,
      color: c.mint,
    },

    /* ---------- Feedback ---------- */
    emptyGlyph: {
      width: 58,
      height: 58,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceHover,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    emptyTitle: {
      fontFamily: fonts.display,
      fontSize: 17,
      color: c.textPrimary,
      marginTop: 14,
      textAlign: "center",
    },
    emptyMessage: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      lineHeight: 18,
      color: c.textMuted,
      textAlign: "center",
      marginTop: 6,
    },
    emptyCta: {
      marginTop: 16,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 9,
    },
    emptyCtaText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12.5,
      color: c.mint,
    },

    /* ---------- Confirm dialog ---------- */
    confirmOverlay: {
      flex: 1,
      backgroundColor: c.scrim,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
    },
    confirmCard: {
      width: "100%",
      maxWidth: 400,
      backgroundColor: c.surface,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 20,
    },
    confirmGlyph: {
      width: 46,
      height: 46,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
      alignSelf: "flex-start",
      backgroundColor: c.surfaceHover,
    },
    confirmTitle: {
      fontFamily: fonts.display,
      fontSize: 18,
      color: c.textPrimary,
      marginTop: 14,
    },
    confirmMessage: {
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 19,
      color: c.textSecondary,
      marginTop: 6,
    },
    confirmSummary: {
      marginTop: 16,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.hairline,
      backgroundColor: c.surfaceHover,
      paddingVertical: 4,
      paddingHorizontal: 14,
    },
    confirmSummaryRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 9,
      gap: 12,
    },
    confirmSummaryRowBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.hairline,
    },
    confirmSummaryLabel: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textMuted,
      flexShrink: 1,
    },
    confirmSummaryValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.textPrimary,
      textAlign: "right",
    },
    confirmSummaryTotal: {
      fontFamily: fonts.bodyBold,
      fontSize: 15,
      color: c.textPrimary,
    },
    confirmWarning: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      marginTop: 14,
    },
    confirmWarningText: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 11.5,
      lineHeight: 16,
      color: c.textMuted,
    },
    confirmActions: {
      flexDirection: "row",
      gap: 10,
      marginTop: 20,
    },
    confirmAction: {
      flex: 1,
      height: 48,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 8,
    },
    confirmActionGhost: {
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      backgroundColor: "transparent",
    },
    confirmActionGhostText: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.textPrimary,
    },
    confirmActionSolid: {
      backgroundColor: c.mint,
    },
    confirmActionDanger: {
      backgroundColor: c.rose,
    },
    confirmActionSolidText: {
      fontFamily: fonts.bodyBold,
      fontSize: 14,
      color: c.onAccent,
    },

    // Consistent block-level spacing helper.
    gap: {
      gap: 12,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.hairline,
    },
  });

/** Convenience hook: palette + a memoised themed stylesheet. */
export function useThemedStyles(shadowFn) {
  const theme = useTheme();
  const styles = useMemo(
    () => themedStyles(theme.c, shadowFn),
    [theme.c, shadowFn],
  );
  return { ...theme, styles };
}

export function ScreenHeader({ title, subtitle, onBack, action, onAction }) {
  const { c, styles } = useThemedStyles();
  return (
    <View style={styles.header}>
      {onBack ? (
        <TouchableOpacity
          style={styles.backButton}
          onPress={onBack}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Ionicons name="chevron-back" size={20} color={c.textPrimary} />
        </TouchableOpacity>
      ) : null}
      <View style={styles.headerTextWrap}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action ? (
        <TouchableOpacity
          style={styles.headerAction}
          onPress={onAction}
          activeOpacity={0.7}
        >
          <Text style={styles.headerActionText}>{action}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function PrimaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  icon,
  style,
}) {
  const { c, styles } = useThemedStyles();
  const isDisabled = disabled || loading;
  return (
    <TouchableOpacity
      style={[
        styles.primaryButton,
        isDisabled && styles.primaryButtonDisabled,
        style,
      ]}
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator size="small" color={c.onAccent} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={16} color={c.onAccent} /> : null}
          <Text style={styles.primaryButtonText}>{title}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

export function SecondaryButton({ title, onPress, icon, style }) {
  const { c, styles } = useThemedStyles();
  return (
    <TouchableOpacity
      style={[styles.secondaryButton, style]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      {icon ? <Ionicons name={icon} size={16} color={c.textPrimary} /> : null}
      <Text style={styles.secondaryButtonText}>{title}</Text>
    </TouchableOpacity>
  );
}

/**
 * Themed text field with an optional leading icon and a right-hand affix
 * (e.g. the show/hide password eye). `error` renders inline.
 */
export function Field({
  label,
  icon,
  affix,
  onAffixPress,
  error,
  containerStyle,
  ...inputProps
}) {
  const { c, styles } = useThemedStyles();
  const [focused, setFocused] = React.useState(false);
  return (
    <View style={containerStyle}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={[styles.field, focused && styles.fieldFocused]}>
        {icon ? (
          <Ionicons
            name={icon}
            size={18}
            color={focused ? c.mint : c.textMuted}
            style={styles.fieldIcon}
          />
        ) : null}
        <TextInput
          {...inputProps}
          style={styles.input}
          placeholderTextColor={c.textMuted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {affix ? (
          <TouchableOpacity
            onPress={onAffixPress}
            activeOpacity={0.7}
            style={styles.inputAffix}
            hitSlop={8}
          >
            <Ionicons name={affix} size={18} color={c.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

export function EmptyState({ icon, title, message, cta, onCta }) {
  const { c, styles } = useThemedStyles();
  return (
    <View
      style={{
        alignItems: "center",
        paddingVertical: 34,
        paddingHorizontal: 28,
      }}
    >
      <View style={styles.emptyGlyph}>
        <Ionicons name={icon} size={26} color={c.textMuted} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.emptyMessage}>{message}</Text> : null}
      {cta ? (
        <TouchableOpacity
          style={styles.emptyCta}
          onPress={onCta}
          activeOpacity={0.85}
        >
          <Text style={styles.emptyCtaText}>{cta}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** Icon tile used in list rows; `tint` is a palette colour. */
export function RowIcon({ icon, tint, size = 18 }) {
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: `${tint}1F`,
      }}
    >
      <Ionicons name={icon} size={size} color={tint} />
    </View>
  );
}

/**
 * Themed destructive/irreversible action confirmation.
 *
 * `Alert.alert` renders a system dialog that cannot show a formatted cost
 * breakdown, and it is a no-op on web. This is the app-native replacement used
 * for flows that debit money without further recoverable steps (e.g. a super
 * agent's wallet purchase straight from a bundle tap).
 *
 * `rows` is an optional [{ label, value, emphasis }] breakdown rendered between
 * the message and the actions.
 */
export function ConfirmDialog({
  visible,
  icon = "help-circle",
  tint,
  title,
  message,
  rows,
  warning,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  confirming = false,
  tone = "default",
}) {
  const { c, styles } = useThemedStyles();
  if (!visible) return null;

  const isDanger = tone === "danger";
  const solidStyle = isDanger
    ? styles.confirmActionDanger
    : styles.confirmActionSolid;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <TouchableOpacity
        style={styles.confirmOverlay}
        activeOpacity={1}
        onPress={confirming ? undefined : onCancel}
      >
        <TouchableOpacity
          style={styles.confirmCard}
          activeOpacity={1}
          onPress={() => {}}
        >
          <View style={styles.confirmGlyph}>
            <Ionicons
              name={icon}
              size={22}
              color={tint || (isDanger ? c.rose : c.mint)}
            />
          </View>

          <Text style={styles.confirmTitle}>{title}</Text>
          {message ? (
            <Text style={styles.confirmMessage}>{message}</Text>
          ) : null}

          {rows && rows.length ? (
            <View style={styles.confirmSummary}>
              {rows.map((row, index) => (
                <View
                  key={row.label}
                  style={[
                    styles.confirmSummaryRow,
                    index < rows.length - 1 && styles.confirmSummaryRowBorder,
                  ]}
                >
                  <Text style={styles.confirmSummaryLabel}>{row.label}</Text>
                  <Text
                    style={[
                      styles.confirmSummaryValue,
                      row.emphasis && styles.confirmSummaryTotal,
                    ]}
                  >
                    {row.value}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {warning ? (
            <View style={styles.confirmWarning}>
              <Ionicons
                name="alert-circle"
                size={14}
                color={c.textMuted}
                style={{ marginTop: 1 }}
              />
              <Text style={styles.confirmWarningText}>{warning}</Text>
            </View>
          ) : null}

          <View style={styles.confirmActions}>
            <TouchableOpacity
              style={[styles.confirmAction, styles.confirmActionGhost]}
              onPress={onCancel}
              disabled={confirming}
              activeOpacity={0.85}
            >
              <Text style={styles.confirmActionGhostText}>{cancelText}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmAction, solidStyle]}
              onPress={onConfirm}
              disabled={confirming}
              activeOpacity={0.85}
            >
              {confirming ? (
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Text style={styles.confirmActionSolidText}>{confirmText}</Text>
              )}
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

/**
 * Drop-in themed shell for screens that have not been converted yet.
 *
 * Wrapping a screen's outermost View in this gives it the correct canvas
 * colour and a status bar that matches the scheme, so dark mode is at least
 * *consistent* app-wide while the rest of the work is in progress. It does not
 * restyle the screen's internals - those still carry their original hardcoded
 * colours until converted.
 */
export function ThemedScreen({ children, style, ...rest }) {
  const { c, isDark, styles } = useThemedStyles();
  return (
    <View
      {...rest}
      style={[styles.screen, { backgroundColor: c.canvas }, style]}
    >
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />
      {children}
    </View>
  );
}
