import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useThemedStyles, themedStyles } from "./ui";
import { fonts } from "./theme";
import {
  COMPLAINT_REASONS,
  buildComplaintMessage,
  openComplaintChat,
} from "../lib/complaints";

/**
 * Complaint sheet for one order.
 *
 * A reason the admin can actually triage, plus free text, plus a live preview
 * of the exact message that will be sent. The preview is the reason this is a
 * sheet rather than a one-tap button: the message is assembled from six
 * separate fields on the order, and a super agent disputing a real payment
 * needs to see what the admin will read before they send it.
 *
 * A reason is required; the typed detail is optional. Defaulting to the first
 * reason would mean every complaint that skipped the picker went out labelled
 * "Data not delivered", which is worse than useless to the admin - so the Send
 * button stays disabled until a reason is actually chosen.
 */
export default function ComplaintSheet({ visible, order, onClose, onError }) {
  const { c, styles } = useThemedStyles();
  const s = useMemo(() => buildStyles(c), [c]);

  const [reasonId, setReasonId] = useState(null);
  const [detail, setDetail] = useState("");
  const [sending, setSending] = useState(false);

  // Reset on open. Without this, reopening the sheet for a DIFFERENT order
  // would carry the previous order's reason and typed detail across - and the
  // user would be looking at someone else's complaint while editing it.
  useEffect(() => {
    if (visible) {
      setReasonId(null);
      setDetail("");
      setSending(false);
    }
  }, [visible, order?.id]);

  const message = useMemo(
    () => (reasonId ? buildComplaintMessage(order, reasonId, detail) : ""),
    [order, reasonId, detail],
  );

  if (!visible) return null;

  const handleSend = async () => {
    if (!reasonId) return;
    setSending(true);
    const result = await openComplaintChat(order, reasonId, detail);
    setSending(false);
    if (result.ok) {
      onClose?.();
    } else {
      onError?.(result.message);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={s.overlay}>
        {/* Tapping the scrim dismisses. A nested TouchableOpacity stops the
            press from bubbling to it - the same pattern ConfirmDialog uses. */}
        <TouchableOpacity
          style={s.scrim}
          activeOpacity={1}
          onPress={sending ? undefined : onClose}
          accessibilityLabel="Close"
        >
          <TouchableOpacity style={s.sheet} activeOpacity={1}>
            {/* Header */}
            <View style={s.head}>
              <View style={s.glyph}>
                <Ionicons name="logo-whatsapp" size={20} color={c.mint} />
              </View>
              <View style={s.headText}>
                <Text style={s.title}>Report a problem</Text>
                <Text style={s.subtitle}>
                  {order?.id != null ? `Order #${order.id}` : "This order"}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                disabled={sending}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={s.close}
              >
                <Ionicons name="close" size={20} color={c.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={s.scroll}
              contentContainerStyle={s.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={s.label}>What went wrong?</Text>
              <View style={s.reasons}>
                {COMPLAINT_REASONS.map((reason) => {
                  const active = reason.id === reasonId;
                  return (
                    <TouchableOpacity
                      key={reason.id}
                      onPress={() => setReasonId(reason.id)}
                      disabled={sending}
                      activeOpacity={0.85}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      style={[s.reason, active && s.reasonActive]}
                    >
                      <Text
                        style={[s.reasonText, active && s.reasonTextActive]}
                      >
                        {reason.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={s.label}>Add details (optional)</Text>
              <TextInput
                value={detail}
                onChangeText={setDetail}
                placeholder="Describe what happened (optional)"
                placeholderTextColor={c.textMuted}
                multiline
                numberOfLines={4}
                maxLength={600}
                editable={!sending}
                textAlignVertical="top"
                style={s.textarea}
                accessibilityLabel="Complaint details"
              />
              <Text style={s.counter}>{detail.length}/600</Text>

              {/* Live preview. Shown once a reason is picked, because the
                  reason is required before the message means anything. */}
              {message ? (
                <View style={s.preview}>
                  <Text style={s.previewLabel}>Message to the admin</Text>
                  <Text style={s.previewBody} selectable>
                    {message}
                  </Text>
                </View>
              ) : null}
            </ScrollView>

            {/* Actions */}
            <View style={s.actions}>
              <TouchableOpacity
                style={[s.action, s.actionGhost]}
                onPress={onClose}
                disabled={sending}
                activeOpacity={0.85}
              >
                <Text style={s.actionGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.action,
                  s.actionSolid,
                  !reasonId && s.actionSolidDisabled,
                ]}
                onPress={handleSend}
                disabled={!reasonId || sending}
                activeOpacity={0.85}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={c.onAccent} />
                ) : (
                  <>
                    <Ionicons
                      name="logo-whatsapp"
                      size={16}
                      color={c.onAccent}
                    />
                    <Text style={s.actionSolidText}>Send to admin</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

// Layered on the shared kit: themedStyles(c) owns the surfaces, borders and
// type ramp, so this only adds the complaint-sheet specific pieces.
const buildStyles = (c) => {
  const base = themedStyles(c);
  return {
    ...base,
    overlay: {
      flex: 1,
      backgroundColor: c.scrim,
      justifyContent: "flex-end",
    },
    scrim: {
      flex: 1,
    },
    sheet: {
      maxHeight: "88%",
      backgroundColor: c.canvasRaised,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: c.hairline,
      paddingTop: 18,
      paddingBottom: 10,
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 18,
      paddingBottom: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.hairline,
    },
    glyph: {
      width: 40,
      height: 40,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: `${c.mint}1F`,
    },
    headText: { flex: 1 },
    title: {
      fontFamily: fonts.display,
      fontSize: 17,
      color: c.textPrimary,
    },
    subtitle: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    close: { padding: 4 },

    scroll: { flexGrow: 0 },
    scrollContent: { padding: 18, gap: 8 },
    label: {
      fontFamily: fonts.bodySemi,
      fontSize: 11.5,
      color: c.textSecondary,
      letterSpacing: 0.3,
      marginTop: 6,
      marginBottom: 2,
    },

    // Wrapping chips rather than a picker: the list is short, and a wrapped
    // grid is faster than opening a modal picker to choose one of seven.
    reasons: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginBottom: 6,
    },
    reason: {
      paddingHorizontal: 13,
      paddingVertical: 9,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      backgroundColor: c.surface,
    },
    reasonActive: {
      backgroundColor: c.mint,
      borderColor: c.mint,
    },
    reasonText: {
      fontFamily: fonts.bodyMedium,
      fontSize: 12.5,
      color: c.textSecondary,
    },
    reasonTextActive: {
      fontFamily: fonts.bodySemi,
      color: c.onAccent,
    },

    textarea: {
      minHeight: 86,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.hairline,
      backgroundColor: c.surface,
      padding: 13,
      fontFamily: fonts.body,
      fontSize: 14,
      lineHeight: 19,
      color: c.textPrimary,
    },
    counter: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      textAlign: "right",
      marginTop: 2,
    },

    // The message is shown before it is sent. Complaints dispute real money,
    // so the user should be able to read exactly what the admin receives.
    preview: {
      marginTop: 8,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.hairline,
      backgroundColor: c.surfaceHover,
      padding: 13,
      gap: 6,
    },
    previewLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 10.5,
      color: c.textMuted,
      letterSpacing: 1.1,
      textTransform: "uppercase",
    },
    previewBody: {
      fontFamily: fonts.body,
      fontSize: 12,
      lineHeight: 17,
      color: c.textSecondary,
    },

    actions: {
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 18,
      paddingTop: 12,
    },
    action: {
      flex: 1,
      height: 48,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 8,
    },
    actionGhost: {
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      backgroundColor: "transparent",
    },
    actionGhostText: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.textPrimary,
    },
    actionSolid: { backgroundColor: c.mint },
    // A grey surface rather than a dimmed mint: at reduced opacity the mint
    // fill still reads as the enabled colour on a dark canvas.
    actionSolidDisabled: { backgroundColor: c.surfaceHover },
    actionSolidText: {
      fontFamily: fonts.bodyBold,
      fontSize: 14,
      color: c.onAccent,
    },
  };
};
