import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  StatusBar,
  Platform,
  ActivityIndicator,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../contexts/ThemeContext";
import { useNotification } from "../contexts/NotificationContext";
import { useProfile } from "../contexts/ProfileContext";
import { getStatusTone, fonts } from "../components/theme";
import { splitReceiptNumber } from "../lib/receiptNumber";
import { formatOrderStatusLabel, resolveOrderStatus } from "../lib/orderStatus";
import {
  canReorderHeldOrders,
  isHeldWindowElapsed,
  isReorderableHeldOrder,
  reorderHeldOrder,
} from "../lib/heldOrderReorder";
import { supabase } from "../lib/supabase";
import { ThemedScreen } from "../components/ui";

export default function ReceiptScreen({ navigation, route }) {
  // The floating back button is absolutely positioned, so it must clear the
  // Android status bar itself - a hardcoded `top: 50` does not adapt to the
  // device inset. iOS already spaces this, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const backTop = Platform.OS === "android" ? insets.top + 10 : 50;
  // Several call sites reach this screen with no params, so `route.params`
  // must not be destructured directly. Without a transaction there is nothing
  // to render, and the old code would have thrown on `transaction.orderType`.
  const transaction = route.params?.transaction || null;
  const { c, isDark, statusTone: tones } = useTheme();
  const { showSuccess, showError } = useNotification();
  const { isSuperAgent: isSuperAgentProfile } = useProfile();
  const s = useMemo(() => buildStyles(c), [c]);
  const [reordering, setReordering] = useState(false);
  // The receipt is reachable from the Home list, History and the sub-agent
  // screens, and only some of those have already resolved the viewer's role. The
  // row itself does not carry it, so the role has to be re-read here. `reorder-
  // held-agent-order` 403s anyone who is not a super agent, so a customer
  // reaching a held row through a sub-agent screen must not be offered a
  // button that can only fail.
  const [isSuperAgentViewer, setIsSuperAgentViewer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (cancelled || !user) return;
        // Role from `public.user_profiles`, not the auth record.
        // `user_metadata` is self-writable and `app_metadata` lives in the
        // access token; neither may decide who is viewing a receipt.
        if (!cancelled) {
          setIsSuperAgentViewer(isSuperAgentProfile);
        }
      } catch (error) {
        // A failed role read leaves the flag false, so the button stays hidden.
        // Defaulting to hidden is the safe direction: it cannot offer an action
        // the server will reject.
        console.error("Could not resolve role for receipt reorder:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A held order the viewer is allowed to retry. The row may be either a
  // sub-agent order (from History / Home) or a bare agent_orders row, so
  // `isReorderableHeldOrder` is the shared test rather than a local one.
  const showReorder =
    canReorderHeldOrders(isSuperAgentViewer) &&
    isReorderableHeldOrder(transaction);
  const reorderElapsed = showReorder
    ? isHeldWindowElapsed(transaction, Date.now())
    : false;

  const handleReorder = async () => {
    setReordering(true);
    try {
      const result = await reorderHeldOrder(transaction);
      if (!result.ok) {
        showError("Reorder Failed", result.message);
        return;
      }
      showSuccess("Order Reordered", "The package was sent to Jehucal.");
    } finally {
      setReordering(false);
    }
  };

  // A card tap passes a History row, which carries both status columns. The
  // shared resolver picks the provider status when it is real and falls back to
  // our internal `status` otherwise - NOT a plain `||` chain, which would let the
  // corrupt boolean string "true" win and then render "Unknown" for an order we
  // knew was completed. See lib/orderStatus.js.
  const rawStatus = resolveOrderStatus(transaction);
  const isAgentOrder = transaction?.orderType === "agent";
  // A wallet top-up reaches this screen from History and from Home. It is not a
  // purchase: it has no network, no package, no recipient and no delivery
  // status. The order markup below would render it as "Data Bundle Purchase",
  // "Ghc 0.00" and a status pill reading "Unknown" - three confident-looking
  // statements, none of them true. Detected here so the whole receipt takes the
  // funding branch rather than patching each field individually.
  const isTopup = transaction?.source === "wallet_topup";
  // The derived `MYS-<id>` receipt number is keyed on an `orders`/`agent_orders`
  // primary key. On a `wallet_topups` row it would render that table's id under
  // the agent prefix - a number support can look up and find nothing - so it is
  // withheld here rather than trusting `orderType`, which this row also carries.
  const receiptParts = useMemo(
    () => (isTopup ? null : splitReceiptNumber(transaction)),
    [isTopup, transaction],
  );
  const tone = useMemo(
    () => getStatusTone(isDark ? "dark" : "light"),
    [isDark],
  )[String(rawStatus || "").toLowerCase()];

  if (!transaction) {
    return (
      <ThemedScreen style={s.container}>
        <View style={s.missingWrap}>
          <Ionicons name="receipt-outline" size={34} color={c.textMuted} />
          <Text style={s.missingTitle}>Receipt unavailable</Text>
          <Text style={s.missingBody}>
            This receipt could not be loaded. Open it again from your order
            history.
          </Text>
          <TouchableOpacity
            style={s.missingCta}
            onPress={() => navigation.goBack()}
            activeOpacity={0.85}
          >
            <Text style={s.missingCtaText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </ThemedScreen>
    );
  }

  const formatDate = (dateString) => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Resolved through the shared tone map so the badge matches the History
  // pills exactly. The old hardcoded hexes were tuned for a white card and
  // were illegible in dark mode. "held" and "expired" are included for the
  // same reason: neither is in the shared map, so both borrow a neighbouring
  // family and keep their own label.
  const getStatusColor = (status) => {
    const key = String(status || "").toLowerCase();
    if (key === "held") return tones.pending?.color || c.amber;
    if (key === "expired") return tones.cancelled?.color || c.rose;
    // "delivered" is not a key in the shared map, and the default below already
    // lands on the same mint the completed family uses, so it needs no branch.
    return tone?.color || c.mint;
  };

  const getStatusText = (status) => formatOrderStatusLabel(status);

  // A top-up's own status vocabulary. `wallet_topups.status` is Paystack's
  // ('pending' | 'success' | 'failed'), and `resolveOrderStatus` returns
  // 'success', which is not a key in the shared order tone map - so the badge
  // would render "Unknown" on a top-up that actually succeeded. Mapped to the
  // order families for COLOUR and given its own wording, so the badge reads
  // "Received" rather than implying a delivery.
  const topupStatusKey = String(transaction?.status || "")
    .trim()
    .toLowerCase();
  const topupStatusLabel =
    topupStatusKey === "success"
      ? "Received"
      : topupStatusKey === "failed"
        ? "Failed"
        : "Pending";
  const displayStatusLabel = isTopup
    ? topupStatusLabel
    : getStatusText(rawStatus);

  return (
    <ThemedScreen style={s.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      {/* Floating Back Button */}
      <TouchableOpacity
        style={[s.floatingBackButton, { top: backTop }]}
        onPress={() => navigation.goBack()}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <View style={s.backButtonCircle}>
          <Ionicons name="arrow-back" size={24} color={c.textPrimary} />
        </View>
      </TouchableOpacity>

      <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.contentHeader}>
          <Text style={s.screenTitle}>Transaction Receipt</Text>
        </View>
        {/* Receipt Header */}
        <View style={s.receiptHeader}>
          <View style={s.receiptIcon}>
            <Ionicons name="receipt" size={40} color={c.mint} />
          </View>
          <Text style={s.receiptTitle}>
            {isTopup
              ? "Wallet Top-up Receipt"
              : isAgentOrder
                ? "Agent Purchase Receipt"
                : "Purchase Receipt"}
          </Text>
          {isAgentOrder && (
            <View style={s.agentBadge}>
              <Ionicons name="shield-checkmark" size={14} color={c.onAccent} />
              <Text style={s.agentBadgeText}>AGENT</Text>
            </View>
          )}
          {/* The row id is only meaningful for orders. On a top-up the
              `wallet_topups` id shares its number space with `agent_orders`, so
              printing it as "ID: 7" invites the reader to look up an unrelated
              order; the Paystack reference below is the citable identifier. */}
          {isTopup ? null : (
            <Text style={s.transactionId}>ID: {transaction.id}</Text>
          )}
          {receiptParts ? (
            <View style={s.receiptNumberPill}>
              <Ionicons name="pricetag" size={13} color={c.onAccent} />
              <Text style={s.receiptNumberText}>
                {receiptParts.prefix}
                {receiptParts.number}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Status Badge */}
        <View style={s.statusContainer}>
          <View
            style={[
              s.statusBadge,
              {
                backgroundColor: isTopup
                  ? // `success` is absent from the order tone map, so the
                    // completed family is borrowed for colour and the label is
                    // overridden below. Without this the badge would fall
                    // through to `c.mint` by accident rather than by decision.
                    (topupStatusKey === "success"
                      ? tones.completed
                      : topupStatusKey === "failed"
                        ? tones.failed
                        : tones.pending
                    )?.color
                  : getStatusColor(rawStatus),
              },
            ]}
          >
            <Text style={s.statusText}>{displayStatusLabel}</Text>
          </View>
        </View>

        {/* Retry a held order. Only rendered for a super agent, only for a row
            the reorder function can actually act on, and only inside the 24h
            window. */}
        {showReorder ? (
          <View style={s.reorderWrap}>
            <TouchableOpacity
              style={[s.reorderButton, reorderElapsed && s.reorderButtonClosed]}
              onPress={handleReorder}
              disabled={reordering || reorderElapsed}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={
                reorderElapsed
                  ? "Reorder window closed"
                  : "Reorder this held order"
              }
            >
              {reordering ? (
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Ionicons
                  name="refresh"
                  size={17}
                  color={reorderElapsed ? c.textMuted : c.onAccent}
                />
              )}
              <Text
                style={[
                  s.reorderButtonText,
                  reorderElapsed && s.reorderButtonTextClosed,
                ]}
              >
                {reorderElapsed
                  ? "Reorder window closed"
                  : reordering
                    ? "Reordering…"
                    : "Reorder this order"}
              </Text>
            </TouchableOpacity>
            <Text style={s.reorderHint}>
              {reorderElapsed
                ? "This order passed its 24 hour window."
                : "Resends this package to the provider. Only a super agent can retry a held order."}
            </Text>
          </View>
        ) : null}

        {/* Top-ups get their own block. The order block below would report
            "Service: Data Bundle Purchase", "Amount: Ghc 0.00" and hide the
            net/gross split that is the whole reason a top-up exists - so it is
            replaced wholesale rather than field-by-field. */}
        {isTopup ? (
          <View style={s.detailsCard}>
            <Text style={s.sectionTitle}>Top-up Details</Text>

            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Funded by</Text>
              <Text style={s.detailValue}>
                {transaction.subAgentName || "Sub-agent"}
              </Text>
            </View>

            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Amount credited</Text>
              <Text style={[s.detailValue, s.amount]}>
                Ghc {Number(transaction.amount || 0).toFixed(2)}
              </Text>
            </View>

            {/*
              `gross_amount` is what Paystack charged, `amount` is the net the
              wallet received (migration 20260927_003). Shown only when both
              exist: a row written before the charge snapshot has no
              `gross_amount`, and rendering "Ghc 0.00" for it would read as a
              real zero rather than as absent data. Falling back to `amount`
              would instead invent a 0% charge rate.
            */}
            {transaction.gross_amount != null &&
            Number(transaction.gross_amount) !== Number(transaction.amount) ? (
              <>
                <View style={s.detailRow}>
                  <Text style={s.detailLabel}>Amount charged</Text>
                  <Text style={s.detailValue}>
                    Ghc {Number(transaction.gross_amount).toFixed(2)}
                  </Text>
                </View>
                <View style={s.detailRow}>
                  <Text style={s.detailLabel}>Platform charge</Text>
                  <Text style={s.detailValue}>
                    Ghc{" "}
                    {(
                      Number(transaction.gross_amount) -
                      Number(transaction.amount || 0)
                    ).toFixed(2)}
                  </Text>
                </View>
              </>
            ) : null}

            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Date & Time</Text>
              <Text style={s.detailValue}>
                {formatDate(transaction.created_at)}
              </Text>
            </View>

            {transaction.reference ? (
              <View style={s.detailRow}>
                <Text style={s.detailLabel}>Reference</Text>
                <Text style={s.detailValue}>{transaction.reference}</Text>
              </View>
            ) : null}

            {transaction.paystack_transaction_id ? (
              <View style={s.detailRow}>
                <Text style={s.detailLabel}>Payment ID</Text>
                <Text style={s.detailValue}>
                  {transaction.paystack_transaction_id}
                </Text>
              </View>
            ) : null}

            {transaction.paid_at ? (
              <View style={s.detailRow}>
                <Text style={s.detailLabel}>Paid At</Text>
                <Text style={s.detailValue}>
                  {formatDate(transaction.paid_at)}
                </Text>
              </View>
            ) : null}
          </View>
        ) : (
          <>
        {/* Transaction Details */}
        <View style={s.detailsCard}>
          <Text style={s.sectionTitle}>Transaction Details</Text>

          {receiptParts ? (
            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Receipt number</Text>
              <Text style={[s.detailValue, s.receiptNumberValue]}>
                {receiptParts.prefix}
                {receiptParts.number}
              </Text>
            </View>
          ) : null}

          <View style={s.detailRow}>
            <Text style={s.detailLabel}>Service</Text>
            <Text style={s.detailValue}>
              {isAgentOrder
                ? "Agent Service"
                : transaction.offer_title || "Data Bundle Purchase"}
            </Text>
          </View>

          {transaction.network && (
            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Network</Text>
              <Text style={s.detailValue}>
                {transaction.network.toUpperCase()}
              </Text>
            </View>
          )}

          {!isAgentOrder && transaction.data_amount && (
            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Data Amount</Text>
              <Text style={s.detailValue}>{transaction.data_amount}</Text>
            </View>
          )}

          <View style={s.detailRow}>
            <Text style={s.detailLabel}>Amount</Text>
            <Text style={[s.detailValue, s.amount]}>
              Ghc {transaction.amount || "0.00"}
            </Text>
          </View>

          <View style={s.detailRow}>
            <Text style={s.detailLabel}>Date & Time</Text>
            <Text style={s.detailValue}>
              {formatDate(transaction.created_at)}
            </Text>
          </View>

          {transaction.payment_reference && (
            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Reference</Text>
              <Text style={s.detailValue}>{transaction.payment_reference}</Text>
            </View>
          )}

          {transaction.paystack_transaction_id && (
            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Payment ID</Text>
              <Text style={s.detailValue}>
                {transaction.paystack_transaction_id}
              </Text>
            </View>
          )}
        </View>

        {/* Customer / Recipient Information. Skipped entirely for a top-up:
            there is no recipient, and a "Phone: N/A" block under a funding
            receipt implies a customer who does not exist. */}
        {isTopup ? null : (
          <View style={s.detailsCard}>
            <Text style={s.sectionTitle}>
              {isAgentOrder ? "Recipient Information" : "Customer Information"}
            </Text>

            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Phone</Text>
              <Text style={s.detailValue}>
                {isAgentOrder
                  ? transaction.displayPhone || "N/A"
                  : transaction.phone || "N/A"}
              </Text>
            </View>

            {!isAgentOrder && transaction.user_email && (
              <View style={s.detailRow}>
                <Text style={s.detailLabel}>Email</Text>
                <Text style={s.detailValue}>{transaction.user_email}</Text>
              </View>
            )}

            {transaction.country_code && (
              <View style={s.detailRow}>
                <Text style={s.detailLabel}>Country</Text>
                <Text style={s.detailValue}>{transaction.country_code}</Text>
              </View>
            )}
          </View>
        )}

        {/* Payment Information. The top-up block above already reports the
            channel, so this would restate it. */}
        {!isTopup && (transaction.bank || transaction.channel) && (
          <View style={s.detailsCard}>
            <Text style={s.sectionTitle}>Payment Information</Text>

            {transaction.bank && (
              <View style={s.detailRow}>
                <Text style={s.detailLabel}>Bank</Text>
                <Text style={s.detailValue}>{transaction.bank}</Text>
              </View>
            )}

            {transaction.channel && (
              <View style={s.detailRow}>
                <Text style={s.detailLabel}>Channel</Text>
                <Text style={s.detailValue}>{transaction.channel}</Text>
              </View>
            )}

            {transaction.paid_at && (
              <View style={s.detailRow}>
                <Text style={s.detailLabel}>Paid At</Text>
                <Text style={s.detailValue}>
                  {formatDate(transaction.paid_at)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Footer */}
        <View style={s.footer}>
          <Text style={s.footerText}>
            Thank you for using Mystiwan-E-Business
          </Text>
          <Text style={s.footerSubText}>
            For support, contact our customer service
          </Text>
        </View>
        </>
        )}
      </ScrollView>
    </ThemedScreen>
  );
}

// Scheme-scoped stylesheet factory, memoised per palette in the component.
// The layout is unchanged from the previous version; only the colours moved
// onto tokens, because every literal here was tuned for a white card and was
// illegible once the app gained a dark scheme.
const buildStyles = (c) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.canvas,
    },
    floatingBackButton: {
      position: "absolute",
      top: 50,
      left: 20,
      zIndex: 10,
    },
    backButtonCircle: {
      width: 45,
      height: 45,
      borderRadius: 23,
      backgroundColor: c.surface,
      justifyContent: "center",
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.hairline,
      elevation: 4,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 4,
    },
    contentHeader: {
      paddingHorizontal: 20,
      marginTop: 110, // Accounts for floating back button
      marginBottom: 10,
    },
    screenTitle: {
      fontFamily: fonts.display,
      fontSize: 26,
      fontWeight: "bold",
      color: c.textPrimary,
    },
    content: {
      flex: 1,
      padding: 10,
    },

    /* ---------- Receipt header ---------- */
    receiptHeader: {
      alignItems: "center",
      backgroundColor: c.surface,
      padding: 30,
      borderRadius: 20,
      marginBottom: 15,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    receiptIcon: {
      marginBottom: 10,
    },
    receiptTitle: {
      fontFamily: fonts.display,
      fontSize: 22,
      fontWeight: "bold",
      color: c.textPrimary,
      marginBottom: 5,
      textAlign: "center",
    },
    transactionId: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textMuted,
      marginTop: 4,
    },
    // Prominent because this is the number a customer reads out to support.
    receiptNumberPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: c.mint,
      paddingHorizontal: 13,
      paddingVertical: 7,
      borderRadius: 999,
      marginTop: 12,
    },
    receiptNumberText: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      letterSpacing: 0.6,
      color: c.onAccent,
    },
    receiptNumberValue: {
      fontFamily: fonts.bodyBold,
      color: c.mint,
      letterSpacing: 0.4,
    },
    agentBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: c.mint,
      paddingHorizontal: 11,
      paddingVertical: 5,
      borderRadius: 999,
      marginTop: 8,
    },
    agentBadgeText: {
      fontFamily: fonts.bodySemi,
      fontSize: 10,
      letterSpacing: 1,
      color: c.onAccent,
    },

    /* ---------- Status badge ---------- */
    statusContainer: {
      alignItems: "center",
      marginBottom: 15,
    },
    statusBadge: {
      paddingHorizontal: 20,
      paddingVertical: 8,
      borderRadius: 20,
    },
    statusText: {
      fontFamily: fonts.bodySemi,
      color: c.onAccent,
      fontSize: 13,
      fontWeight: "bold",
    },

    /* ---------- Reorder (held orders) ---------- */
    reorderWrap: {
      alignItems: "center",
      marginBottom: 15,
      gap: 7,
    },
    reorderButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      alignSelf: "stretch",
      paddingVertical: 13,
      borderRadius: 999,
      backgroundColor: c.mint,
    },
    // Grey surface rather than a dimmed mint: at reduced opacity the mint fill
    // still reads as the enabled colour against a dark canvas.
    reorderButtonClosed: { backgroundColor: c.surfaceHover },
    reorderButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 15,
      color: c.onAccent,
    },
    reorderButtonTextClosed: { color: c.textMuted },
    reorderHint: {
      fontFamily: fonts.body,
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
      textAlign: "center",
    },

    /* ---------- Detail cards ---------- */
    detailsCard: {
      backgroundColor: c.surface,
      borderRadius: 20,
      padding: 20,
      marginBottom: 15,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    sectionTitle: {
      fontFamily: fonts.display,
      fontSize: 16,
      fontWeight: "bold",
      color: c.textPrimary,
      marginBottom: 15,
      borderBottomWidth: 1,
      borderBottomColor: c.hairline,
      paddingBottom: 10,
    },
    detailRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.hairline,
    },
    // textSecondary rather than textMuted: `textMuted` is 4.18:1 on this card
    // in dark mode, under the 4.5:1 required for 13px text. That token is a
    // pre-existing app-wide shortfall; this screen uses the next token up
    // rather than widening the palette from one file.
    detailLabel: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textSecondary,
      fontWeight: "500",
    },
    detailValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.textPrimary,
      textAlign: "right",
      flex: 1,
      marginLeft: 10,
    },
    amount: {
      fontFamily: fonts.display,
      fontSize: 16,
      color: c.rose,
      fontWeight: "bold",
    },

    /* ---------- Empty state (no transaction in params) ---------- */
    missingWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 28,
      paddingTop: 90,
    },
    missingTitle: {
      fontFamily: fonts.display,
      fontSize: 17,
      color: c.textPrimary,
      marginTop: 14,
    },
    missingBody: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      lineHeight: 18,
      color: c.textSecondary,
      textAlign: "center",
      marginTop: 6,
    },
    missingCta: {
      marginTop: 16,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 9,
    },
    missingCtaText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12.5,
      color: c.mint,
    },

    /* ---------- Footer ---------- */
    footer: {
      alignItems: "center",
      backgroundColor: c.mint,
      padding: 25,
      borderRadius: 20,
      marginTop: 10,
      marginBottom: 20,
    },
    footerText: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.onAccent,
      textAlign: "center",
    },
    footerSubText: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.onAccent,
      marginTop: 5,
      opacity: 0.8,
    },
  });
