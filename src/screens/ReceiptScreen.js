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
import { formatOrderStatusLabel, resolveOrderStatus, isRealStatus } from "../lib/orderStatus";
import {
  canReorderHeldOrders,
  isHeldWindowElapsed,
  isReorderableHeldOrder,
  reorderHeldOrder,
} from "../lib/heldOrderReorder";
import { supabase } from "../lib/supabase";
import { ThemedScreen } from "../components/ui";

// `null` / `undefined` render as an em dash rather than "Ghc 0.00". The
// difference matters in a settlement panel: a provider fee of 0 is a real fact,
// while an unrecorded figure is not, and the old mapping made the two look
// identical.
const formatGhcOptional = (value) => {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `Ghc ${parsed.toFixed(2)}` : "—";
};

const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

/**
 * One settlement line: label, dotted leader, right-aligned figure.
 *
 * `flex: 1` on the leader is what makes the values stack into a column - which
 * is the only way a reader can check that the margin plus the platform's cut
 * adds back up to what the customer paid.
 *
 * Drawn as characters rather than `borderStyle: "dotted"`, which Android
 * renders inconsistently.
 */
function SettlementRow({ label, value, tint }) {
  const { c } = useTheme();
  return (
    <View style={settlementStyles.row}>
      <Text style={[settlementStyles.label, { color: c.textMuted }]}>
        {label}
      </Text>
      <Text
        style={[settlementStyles.leader, { color: c.hairlineStrong }]}
        numberOfLines={1}
      >
        · · · · · · · · · · · · · · · · · ·
      </Text>
      <Text
        style={[
          settlementStyles.value,
          tint ? { color: tint } : { color: c.textPrimary },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const settlementStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
  },
  label: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    maxWidth: "46%",
  },
  leader: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 11,
    letterSpacing: 1.6,
    opacity: 0.5,
    textAlign: "center",
  },
  value: {
    fontFamily: fonts.bodySemi,
    fontSize: 12.5,
    fontVariant: ["tabular-nums"],
  },
});

export default function ReceiptScreen({ navigation, route }) {
  // On web this route can be entered cold - deep link, reload, bookmark - so
  // there may be nothing behind it and `goBack()` would warn that no navigator
  // handled it. Same guard as HistoryScreen, ProfileScreen and
  // NotificationsScreen.
  const handleBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate("Home");
  };
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
            onPress={handleBack}
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

    // ===========================================================================
    // BOTH STATUSES, NOT ONE
    // ===========================================================================
    // An order carries two status columns and they answer different questions:
    //
    //   `status`              OUR internal state. Written at creation, then by
    //                         dispatch and the 24h expiry sweep. The app's own
    //                         record of what it decided.
    //   `jehuca_order_status` the PROVIDER's state, mirrored. Authoritative on
    //                         whether data actually landed, and often newer than
    //                         ours.
    //
    // The old badge showed ONE of them via `resolveOrderStatus`, which picks the
    // provider status when it is real and falls back to ours otherwise. That is the
    // correct answer to "what state is this order in?" - but it destroys the one
    // thing worth knowing when they DISAGREE:
    //
    //   status=completed, jehuca=processing
    //       We think we finished. The provider says it has not. The package has
    //       not arrived and nothing is wrong yet - but this order needs watching,
    //       and the old badge made it look settled.
    //
    //   status=processing, jehuca=completed
    //       Data landed but our own record never caught up. Harmless, and the
    //       customer is owed reassurance.
    //
    // On a support ticket ("I paid and nothing arrived") that gap is the whole
    // question, and one merged badge cannot answer it. So both are shown, each
    // labelled with what it actually is.
    //
    // A top-up has no provider leg at all - no package was dispatched - so the
    // panel collapses to its single row rather than rendering an "Awaiting
    // provider" that would imply a dispatch that never happened.
    const internalStatus = isRealStatus(transaction?.status)
      ? transaction.status.trim()
      : null;
    const providerStatus = isRealStatus(transaction?.jehuca_order_status)
      ? transaction.jehuca_order_status.trim()
      : null;
    // Whether the two tell different stories. Drives the disagreement note, and is
    // the only case where the panel needs to draw attention to itself.
    const statusDisagreement =
      !isTopup &&
      internalStatus != null &&
      providerStatus != null &&
      internalStatus.toLowerCase() !== providerStatus.toLowerCase();

      // The settlement block belongs to a super agent looking at somebody else's
      // purchase. Gated on the ROW, not just the role: a super agent's own order is
      // still their own order, and showing them a "your margin" line over money they
      // spent themselves would be a category error. `isSubAgentTransaction` is the
      // flag History sets on both sub-agent shapes.
      const showSettlement =
      !isTopup &&
      isSuperAgentViewer &&
      Boolean(transaction?.isSubAgentTransaction);

  return (
    <ThemedScreen style={s.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
              {/* Back button and page title on ONE line.

                  The button used to float at an absolute `top` while the title sat
                  110px below it in a separate block - so the two were vertically
                  independent, and the reserved gap showed as dead space above the
                  header on every device. Making the button the first child of the
                  header row removes both the absolute positioning and the magic
                  number: they are now aligned by the same flex row, so they cannot
                  drift apart at a different inset or font scale.

                  The inset moves onto the row itself as padding, which is what
                  actually keeps the button clear of the Android status bar. */}
              <View style={[s.contentHeader, { paddingTop: backTop - 6 }]}>
                <TouchableOpacity
                  style={s.backButton}
                  onPress={handleBack}
                  activeOpacity={0.7}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Go back"
                >
                  <Ionicons name="chevron-back" size={20} color={c.textPrimary} />
                </TouchableOpacity>
                <View style={s.contentHeaderText}>
                  <Text style={s.screenTitle}>Receipt</Text>
                </View>
              </View>

                      {/* Receipt Header */}
        <View style={s.receiptHeader}>
                  <Text style={s.receiptEyebrow}>
                    {isTopup
                      ? "Funding"
                      : isAgentOrder
                        ? "Agent purchase"
                        : "Data purchase"}
                  </Text>
                  <Text style={s.receiptTitle}>
                    {isTopup
                      ? "Wallet Top-up"
                      : isAgentOrder
                        ? "Agent Purchase"
                        : "Data Bundle"}
                  </Text>
                  {/* The row id is only meaningful for orders. On a top-up the
                      `wallet_topups` id shares its number space with `agent_orders`, so
                      printing it as "ID: 7" invites the reader to look up an unrelated
                      order; the Paystack reference below is the citable identifier. */}
                  {isTopup ? null : (
                    <Text style={s.transactionId}>Order ID {transaction.id}</Text>
                  )}
                </View>

                {/* THE RECEIPT NUMBER. Moved out of the header block and set as its own
                    masthead element, because it is the one identifier a customer reads
                    aloud to support - it should be the largest, most obviously citable
                    thing on the page, not a small pill competing with a decorative
                    receipt glyph. */}
                {receiptParts ? (
                  <View style={s.receiptNumberPanel}>
                    <Text style={s.receiptNumberCaption}>Receipt number</Text>
                    <View style={s.receiptNumberRow}>
                      <Text style={s.receiptNumberDisplay}>{receiptParts.prefix}</Text>
                      <Text style={s.receiptNumberDigits}>{receiptParts.number}</Text>
                    </View>
                  </View>
                ) : null}

        {/* ======================================================================
                    STATUS - BOTH TRACKS

                    Two rows, two sources, labelled with what each one actually is.
                    The headline is the PROVIDER status where we have one, because on a
                    dispute the question is always "did the data land?", and only the
                    provider knows.

                    The old single badge collapsed these via `resolveOrderStatus`, which
                    is right for "what state is this?" and useless for "why do I think
                    it says one thing and the provider another?" See the note where
                    `statusDisagreement` is computed.
                    ====================================================================== */}
                <View style={s.statusPanel}>
                  <View style={s.statusPanelHead}>
                    <Text style={s.statusPanelTitle}>Status</Text>
                    {statusDisagreement ? (
                      <View style={s.statusFlag}>
                        <Ionicons name="git-compare-outline" size={11} color={c.amber} />
                        <Text style={s.statusFlagText}>Sources differ</Text>
                      </View>
                    ) : null}
          </View>

                  {/* Track 1 - the provider. First because it is the authority on
                      delivery, and because on a top-up this row does not exist at all. */}
                  {isTopup ? null : (
                    <View style={s.statusTrack}>
                      <View style={s.statusTrackHead}>
                        <View style={s.statusTrackLabelWrap}>
                          <Ionicons
                            name="radio-outline"
                            size={13}
                            color={c.textMuted}
                          />
                          <Text style={s.statusTrackLabel}>Provider status</Text>
                        </View>
                        {providerStatus ? (
                          <View
                            style={[
                              s.statusChip,
                              { backgroundColor: getStatusColor(providerStatus) },
                            ]}
                          >
                            <Text style={s.statusChipText}>
                              {getStatusText(providerStatus)}
                            </Text>
                          </View>
                        ) : (
                          <Text style={s.statusPending}>Not reported yet</Text>
                        )}
                      </View>
                      {/* A provider id that has aged out of the ~10-order retention
                          window still needs saying, so a failed refresh reads as "we
                          checked and it is gone" rather than as "we never tried". */}
                      {transaction.jehuca_order_id ? (
                        <Text style={s.statusTrackMeta}>
                          Reference {transaction.jehuca_order_id}
                        </Text>
                      ) : null}
                    </View>
                  )}

                  {/* Track 2 - ours. Always shown, including for a top-up, because it is
                      the app's own record of what it decided. */}
                  <View
                    style={[
                      s.statusTrack,
                      isTopup ? null : s.statusTrackDivided,
                    ]}
                  >
                    <View style={s.statusTrackHead}>
                      <View style={s.statusTrackLabelWrap}>
                        <Ionicons name="apps-outline" size={13} color={c.textMuted} />
                        <Text style={s.statusTrackLabel}>
                          {isTopup ? "Paystack" : "Our status"}
                        </Text>
                      </View>
                      <View
                        style={[
                          s.statusChip,
                          {
                            backgroundColor: isTopup
                              ? (topupStatusKey === "success"
                                ? tones.completed
                                : topupStatusKey === "failed"
                                  ? tones.failed
                                  : tones.pending
                              )?.color
                              // `internalStatus` ONLY - never `internalStatus ||
                              // rawStatus`.
                              //
                              // `rawStatus` is the RESOLVED status, which prefers the
                              // provider's value whenever it is real. Falling back to it
                              // therefore made the internal track print the PROVIDER's
                              // word, so both rows showed the same status and the panel
                              // claimed two sources while displaying one fact twice - and
                              // it did so silently, which is worse than not showing the
                              // split at all.
                              //
                              // When our own column is blank there is nothing to report
                              // for this track. It renders as unresolved below rather
                              // than borrowing the other track's answer.
                              : internalStatus
                              ? getStatusColor(internalStatus)
                              : c.surfaceHover,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            s.statusChipText,
                            // `onAccent` is dark ink for a coloured chip; on the neutral
                            // fallback surface it would be near-invisible. Switched with
                            // the chip so an unresolved track reads as "not reported"
                            // rather than as blank text.
                            !isTopup && !internalStatus ? s.statusChipTextNeutral : null,
                          ]}
                        >
                          {isTopup
                            ? displayStatusLabel
                            : internalStatus
                              ? getStatusText(internalStatus)
                              : "Not recorded"}
                        </Text>
                      </View>
                    </View>
                    {transaction.settlement_status ? (
                      <Text style={s.statusTrackMeta}>
                        Settlement {transaction.settlement_status}
                      </Text>
                    ) : null}
                  </View>

                  {/* The one place the two statuses are put side by side and named as a
                      conflict. Written as an explanation rather than an alarm: a
                      mismatch is usually a lag between our write and the provider's, not
                      a lost order. */}
                  {statusDisagreement ? (
                    <View style={s.statusNote}>
                      <Ionicons
                        name="information-circle-outline"
                        size={15}
                        color={c.amber}
                      />
                      <Text style={s.statusNoteText}>
                        Our record says{" "}
                        <Text style={s.statusNoteStrong}>
                          {getStatusText(internalStatus)}
                        </Text>{" "}
                        while the provider reports{" "}
                        <Text style={s.statusNoteStrong}>
                          {getStatusText(providerStatus)}
                        </Text>
                        . The provider's status is the one that reflects whether the
                        data actually landed.
                      </Text>
                    </View>
                  ) : null}
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

                  {/* ==================================================================
                      SETTLEMENT

                      Only for a super agent looking at a sub-agent's order. Same
                      arithmetic and same visual grammar as the History card's panel -
                      dotted leaders, aligned figures, margin as a total - because a
                      super agent reconciling a number here is doing the same arithmetic
                      they did there, and two representations of one figure is how two
                      screens end up disagreeing about the same transaction.

                      The receipt number is deliberately NOT repeated: it is already the
                      masthead element directly above, and printing it twice on one page
                      reads as two different receipts.
                      ================================================================== */}
                  {showSettlement ? (
                    <View style={s.settlementPanel}>
                      <Text style={s.settlementTitle}>Settlement</Text>

                      <View style={s.settlementRows}>
                        <SettlementRow
                          label="Customer paid"
                          value={formatGhc(transaction.amount)}
                        />
                        {transaction.base_amount != null ? (
                          <SettlementRow
                            label="Paid to platform"
                            value={formatGhc(transaction.base_amount)}
                          />
                        ) : null}
                        <SettlementRow
                          label="Provider fee"
                          value={formatGhcOptional(transaction.transaction_fee)}
                          tint={transaction.transaction_fee ? c.amber : undefined}
                        />
                      </View>

                      <View style={s.settlementTotal}>
                        <Text style={s.settlementTotalLabel} numberOfLines={1}>
                                                  Your margin
                                                </Text>
                                                <Text style={s.settlementTotalValue} numberOfLines={1}>
                                                  {formatGhcOptional(transaction.super_agent_share)}
                                                </Text>
                      </View>
                    </View>
                  ) : null}

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
    // Retained only for the `missing` early return's own layout; the scroll header
        // uses `backButton` above.
        floatingBackButton: {
          position: "absolute",
          top: 50,
          left: 20,
          zIndex: 10,
        },
    // One flex row holding the back button and the title. `paddingTop` is
        // overridden per-device at the call site with the safe-area inset; the 12
        // here is the resting value for devices that need none.
        contentHeader: {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 10,
          paddingTop: 12,
          paddingBottom: 14,
    },
        contentHeaderText: {
      flex: 1,
        },
        backButton: {
          width: 38,
          height: 38,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c.surface,
          borderWidth: 1,
          borderColor: c.hairline,
        },
        screenTitle: {
          fontFamily: fonts.display,
          fontSize: 20,
          color: c.textPrimary,
        },
        content: {
          flex: 1,
          paddingHorizontal: 10,
        },

    /* ---------- Receipt header ---------- */
        // Left-aligned rather than centred. A receipt is a document, not a badge,
        // and the masthead reading as a heading is what makes the page legible in
        // one scan instead of four stacked centred objects.
        receiptHeader: {
          alignItems: "flex-start",
          backgroundColor: c.surface,
          padding: 20,
          borderRadius: 20,
          marginBottom: 12,
          borderWidth: 1,
          borderColor: c.hairline,
    },
        receiptEyebrow: {
          fontFamily: fonts.bodySemi,
          fontSize: 9.5,
          color: c.mintDim,
          letterSpacing: 1.4,
          textTransform: "uppercase",
        },
        receiptTitle: {
          fontFamily: fonts.display,
          fontSize: 24,
          fontWeight: "bold",
          color: c.textPrimary,
          marginTop: 5,
    },
        transactionId: {
          fontFamily: fonts.body,
          fontSize: 11.5,
          color: c.textMuted,
          marginTop: 6,
          letterSpacing: 0.3,
        },

        /* ---------- Receipt number masthead ----------
            The one identifier a customer reads aloud to support, so it gets its own
            panel at display scale rather than a small pill inside the header. */
        receiptNumberPanel: {
          backgroundColor: c.surfaceSunken,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: c.hairline,
          paddingVertical: 16,
          paddingHorizontal: 20,
          marginBottom: 12,
        },
        receiptNumberCaption: {
          fontFamily: fonts.bodySemi,
          fontSize: 9.5,
          color: c.textMuted,
          letterSpacing: 1.3,
          textTransform: "uppercase",
        },
        receiptNumberRow: {
          flexDirection: "row",
          alignItems: "baseline",
          gap: 8,
          marginTop: 4,
        },
        receiptNumberDisplay: {
          fontFamily: fonts.bodySemi,
          fontSize: 16,
          color: c.textMuted,
          letterSpacing: 0.5,
        },
        // Tabular so digits sit on a grid - a citable number has to be readable
        // digit by digit.
        receiptNumberDigits: {
          fontFamily: fonts.displayBold,
          fontSize: 30,
          color: c.mint,
          fontVariant: ["tabular-nums"],
          letterSpacing: 1,
        },

        /* ---------- Status: both tracks ---------- */
        statusPanel: {
          backgroundColor: c.surface,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: c.hairline,
          padding: 20,
          marginBottom: 15,
        },
        statusPanelHead: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        },
        statusPanelTitle: {
          fontFamily: fonts.bodySemi,
          fontSize: 9.5,
          color: c.textMuted,
          letterSpacing: 1.3,
          textTransform: "uppercase",
        },
        // Amber rather than rose: a mismatch is almost always a lag between our
        // write and the provider's, not a lost order. Alarming it would make people
        // panic over bookkeeping.
        statusFlag: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          backgroundColor: `${c.amber}1F`,
          paddingHorizontal: 9,
          paddingVertical: 4,
          borderRadius: 999,
        },
        statusFlagText: {
          fontFamily: fonts.bodySemi,
          fontSize: 9.5,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: c.amber,
        },
        statusTrack: {
          gap: 4,
        },
        statusTrackDivided: {
          marginTop: 12,
          paddingTop: 12,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: c.hairline,
        },
        statusTrackHead: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        },
        statusTrackLabelWrap: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          flex: 1,
        },
        statusTrackLabel: {
          fontFamily: fonts.body,
          fontSize: 13,
          color: c.textSecondary,
        },
        statusChip: {
          paddingHorizontal: 11,
          paddingVertical: 5,
          borderRadius: 999,
        },
        statusChipText: {
          fontFamily: fonts.bodyBold,
          color: c.onAccent,
          fontSize: 10.5,
          letterSpacing: 0.5,
          textTransform: "uppercase",
        },
        // For the neutral `surfaceHover` fallback chip, where dark ink would be
        // unreadable. Paired with `statusChipText` so an unresolved track is legible
        // rather than blank.
        statusChipTextNeutral: {
          color: c.textMuted,
        },
        statusPending: {
          fontFamily: fonts.body,
          fontSize: 12,
          color: c.textMuted,
          fontStyle: "italic",
        },
        statusTrackMeta: {
          fontFamily: fonts.body,
          fontSize: 11,
          color: c.textMuted,
          marginTop: 2,
        },
        statusNote: {
          flexDirection: "row",
          gap: 8,
          marginTop: 13,
          paddingTop: 12,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: c.hairline,
          alignItems: "flex-start",
        },
        statusNoteText: {
          flex: 1,
          fontFamily: fonts.body,
          fontSize: 12,
          lineHeight: 18,
          color: c.textSecondary,
        },
        statusNoteStrong: {
          fontFamily: fonts.bodyBold,
          color: c.textPrimary,
        },

        /* ---------- Settlement ---------- */
        settlementPanel: {
          backgroundColor: c.surface,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: c.hairline,
          padding: 20,
          marginBottom: 15,
        },
        settlementTitle: {
          fontFamily: fonts.bodySemi,
          fontSize: 9.5,
          color: c.mintDim,
          letterSpacing: 1.3,
          textTransform: "uppercase",
          marginBottom: 13,
        },
        settlementRows: {
          gap: 8,
        },
        settlementTotal: {
          flexDirection: "row",
                  // Centered rather than baseline: a 22px figure against an 11.5px
                  // uppercase caption sits visibly high on a baseline and reads as two
                  // misaligned elements rather than one row.
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
          marginTop: 13,
          paddingTop: 12,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: c.hairlineStrong,
        },
        settlementTotalLabel: {
          fontFamily: fonts.bodySemi,
          fontSize: 11.5,
          color: c.textSecondary,
          letterSpacing: 0.6,
          textTransform: "uppercase",
                  // Same contract as `HistoryScreen`'s total row: the label truncates,
                  // the figure never wraps. Without this a long label pushes the margin
                  // onto a second line beneath its own caption.
                  flexShrink: 1,
                },
                settlementTotalValue: {
                  fontFamily: fonts.displayBold,
                  fontSize: 22,
                  color: c.mint,
                  fontVariant: ["tabular-nums"],
                  flexShrink: 0,
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
        // An eyebrow rather than a display-serif heading with a rule under it: the
        // receipt already has two display-scale headings above it, and a third
        // would flatten the hierarchy. The section labels are structure, not titles.
        sectionTitle: {
          fontFamily: fonts.bodySemi,
          fontSize: 9.5,
          color: c.textMuted,
          letterSpacing: 1.3,
          textTransform: "uppercase",
          marginBottom: 6,
        },
        detailRow: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          paddingVertical: 11,
          borderBottomWidth: StyleSheet.hairlineWidth,
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
          fontVariant: ["tabular-nums"],
    },
        // Mint rather than rose: the old red read as a warning on an amount that is
        // simply what was paid. Colour here should mean "where the money went", not
        // "something is wrong".
        amount: {
          fontFamily: fonts.displayBold,
          fontSize: 17,
          color: c.mint,
          fontVariant: ["tabular-nums"],
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
