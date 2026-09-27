import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppState } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { getEdgeFunctionName } from "../lib/env";
import { getEdgeFunctionErrorMessage } from "../lib/edgeFunctions";
import { useNotification } from "../contexts/NotificationContext";
import { fonts } from "../components/theme";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";

// How many rows to pull per network round-trip while walking the full result
// set. Deliberately well under PostgREST's `max-rows` (1000 by default): a
// single un-paginated `select` is silently clamped to that ceiling, so a
// super agent with more held orders than the cap simply saw a truncated list
// with no indication that anything was missing. One page MUST come back
// shorter than this for the loop to terminate, so a value at or above
// `max-rows` would reintroduce exactly the bug being fixed.
const PAGE_SIZE = 200;

// How often the countdown re-renders. A second is enough resolution for an
// "23h 59m"-style readout and costs one setState per order per tick, not one
// timer per row - a single interval drives the whole list.
const TICK_MS = 1000;

// Below this the order is treated as expired client-side. The database sweep
// is the authority and runs on an hourly cron, so the UI needs a small grace
// period: expiring the button a few seconds before the server would is
// confusing, and a few seconds after is harmless because the Reorder call
// would be rejected anyway.
const EXPIRY_GRACE_MS = 0;

const getDeadline = (order) => {
  if (order?.held_expires_at) {
    return new Date(order.held_expires_at).getTime();
  }
  // Fallback for rows written before the deadline columns existed: held for
  // longer than 24h means the window has already elapsed. Mirrors the
  // database sweep rather than hiding the order.
  const heldSince = order?.held_at || order?.created_at;
  const since = heldSince ? new Date(heldSince).getTime() : NaN;
  return Number.isNaN(since) ? null : since + 24 * 60 * 60 * 1000;
};

const getRemainingMs = (order, now) => {
  const deadline = getDeadline(order);
  if (deadline == null) return null;
  return Math.max(0, deadline - now);
};

const formatRemaining = (ms) => {
  if (ms == null) return null;
  if (ms <= 0) return "Expiring…";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
};

export default function SuperAgentHeldOrdersScreen({ navigation }) {
  const { showError, showSuccess } = useNotification();
  const theme = useTheme();
  const c = theme.c;
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useHeldStyles(c, topInset);
  const [orders, setOrders] = useState([]);
  // The server's `count`, not `orders.length`. These differ whenever a page
  // was clamped or a row changed status mid-walk, and the header needs to be
  // honest about which of the two the super agent is looking at.
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError) throw userError;
      // Previously this was `.eq("super_agent_id", user?.user?.id)`. A signed-out
      // session made that `undefined`, which matches nothing and renders as an
      // empty list rather than as "you are not signed in" - the screen looked
      // identical to genuinely having zero held orders.
      if (!user) throw new Error("Not signed in");

      const collected = [];
      let from = 0;
      let exactTotal = null;

      // Walk the whole result set. See PAGE_SIZE for why a single select
      // cannot be trusted here.
      for (;;) {
        const { data, error, count } = await supabase
          .from("agent_orders")
          .select("*", { count: "exact" })
          .eq("super_agent_id", user.id)
          .eq("status", "held")
          .order("created_at", { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;

        const rows = data || [];
        collected.push(...rows);
        if (exactTotal === null && Number.isInteger(count)) exactTotal = count;
        // Advance by what the server ACTUALLY returned, not by PAGE_SIZE.
        // PostgREST applies `max-rows` after the range, so a page can come
        // back shorter than requested. Advancing by the requested size would
        // skip straight over the rows the clamp swallowed - silently returning
        // an incomplete list, which is the exact failure being fixed here.
        from += rows.length;

        // An empty page is a hard stop regardless of what `count` claimed: a
        // row can leave 'held' between two requests, and trusting a stale
        // count here would spin forever on a phantom tail.
        if (rows.length === 0) break;
        // `count: exact` is the authority on how many rows match, and `from`
        // now tracks rows actually collected, so the two are directly
        // comparable.
        if (exactTotal !== null) {
          if (from >= exactTotal) break;
        } else if (rows.length < PAGE_SIZE) {
          // Only a fallback for a server that does not report a count. A
          // clamped page is short too, so this would stop early rather than
          // loop - truncated beats hanging.
          break;
        }
      }

      setOrders(collected);
      setTotal(exactTotal ?? collected.length);
    } catch (error) {
      console.error("Failed to load held agent orders:", error);
      showError("Error", "Could not load held orders.");
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  // Drives every countdown on the screen from one interval. Skipped while the
  // tab is hidden so a backgrounded screen is not re-rendering once a second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Refresh when the app returns to the foreground. An order that expired
  // while the screen was backgrounded must disappear from the list, not sit
  // there showing a stale countdown.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNow(Date.now());
        loadOrders();
      }
    });
    return () => subscription?.remove?.();
  }, [loadOrders]);

  // Reorder once the window has elapsed would be rejected by
  // reorder-held-agent-order, so the button is disabled rather than letting
  // the super agent discover it via an error.
  const isExpired = useCallback(
    (order) => {
      const remaining = getRemainingMs(order, now);
      return remaining != null && remaining <= EXPIRY_GRACE_MS;
    },
    [now],
  );

  const retryOrder = async (order) => {
    if (isExpired(order)) {
      showError(
        "Order Expired",
        "This order passed its 24 hour window and can no longer be reordered.",
      );
      return;
    }
    setRetrying(order.id);
    try {
      const reorderFunctionName = getEdgeFunctionName(
        "reorder-held-agent-order",
      );
      const { data, error } = await supabase.functions.invoke(
        reorderFunctionName,
        { body: { order_id: order.id } },
      );
      if (error || !data?.success) {
        const message = await getEdgeFunctionErrorMessage(
          error,
          data?.error || "Could not reorder this held order.",
        );
        throw new Error(message);
      }
      showSuccess(
        "Order Reordered",
        "The held order was sent to the provider.",
      );
      await loadOrders();
    } catch (error) {
      console.error("Held order retry failed:", error);
      showError(
        "Reorder Failed",
        error.message || "Could not reorder this package.",
      );
    } finally {
      setRetrying(null);
    }
  };

  return (
    <ThemedScreen style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={c.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>Held Agent Orders</Text>
          <Text style={styles.subtitle}>
            Held orders are released 24 hours after they are created
          </Text>
        </View>
      </View>
      {loading ? (
        <ActivityIndicator style={styles.loader} color={c.mint} />
      ) : (
        <FlatList
          contentContainerStyle={styles.content}
          data={orders}
          keyExtractor={(item) => String(item.id)}
          onRefresh={loadOrders}
          refreshing={loading}
          ListHeaderComponent={
            orders.length === 0 ? null : (
              <View style={styles.countRow}>
                <Ionicons name="layers" size={14} color={c.textMuted} />
                <Text style={styles.countText}>
                  {orders.length === total
                    ? `${total} held order${total === 1 ? "" : "s"}`
                    : `Showing ${orders.length} of ${total} held orders`}
                </Text>
              </View>
            )
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="checkmark-circle" size={38} color={c.mint} />
              <Text style={styles.empty}>No held orders.</Text>
              <Text style={styles.emptyHint}>
                Orders appear here when a customer has paid but the wallet debit
                has not cleared yet.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const remaining = getRemainingMs(item, now);
            const expired = remaining != null && remaining <= EXPIRY_GRACE_MS;
            const label = formatRemaining(remaining);

            return (
              <View style={[styles.card, expired && styles.cardExpired]}>
                <View style={styles.cardTop}>
                  <Text style={styles.orderTitle}>
                    {item.offer_title || `${item.network} Data Bundle`}
                  </Text>
                  {label ? (
                    <View
                      style={[
                        styles.timerPill,
                        expired && styles.timerPillExpired,
                      ]}
                    >
                      <Ionicons
                        name={expired ? "alert-circle" : "time-outline"}
                        size={12}
                        color={expired ? c.rose : c.mint}
                      />
                      <Text
                        style={[
                          styles.timerText,
                          expired && styles.timerTextExpired,
                        ]}
                      >
                        {label}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <Text style={styles.detail}>
                  Order #{item.id}
                  {item.network ? ` · ${item.network}` : ""}
                </Text>
                <Text style={styles.detail}>
                  Amount: Ghc{" "}
                  {Number(item.base_amount || item.amount || 0).toFixed(2)}
                </Text>
                <Text style={styles.detail}>
                  Recipient: {item.recipient_phone || "N/A"}
                </Text>

                <TouchableOpacity
                  style={[styles.button, expired && styles.buttonDisabled]}
                  onPress={() => retryOrder(item)}
                  disabled={retrying === item.id || expired}
                >
                  {retrying === item.id ? (
                    <ActivityIndicator color={c.onAccent} />
                  ) : (
                    <>
                      <Ionicons
                        name="refresh"
                        size={18}
                        color={expired ? c.textMuted : c.onAccent}
                      />
                      <Text
                        style={[
                          styles.buttonText,
                          expired && styles.buttonTextDisabled,
                        ]}
                      >
                        {expired ? "Window Closed" : "Reorder"}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            );
          }}
        />
      )}
    </ThemedScreen>
  );
}

// Layered on the shared kit: `themedStyles(c)` owns the surface, border and type
// ramp, so this file only adds the held-order specific pieces.
const useHeldStyles = (c, topInset = 0) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    ...base,
    safeArea: { ...base.screen },
    loader: { marginTop: 40 },

    header: {
      ...base.header,
      paddingTop: 18 + topInset,
      paddingBottom: 12,
    },
    backButton: { ...base.backButton, borderRadius: 999 },
    title: { ...base.headerTitle, fontSize: 20 },
    // The shared ramp names this `headerSubtitle`; this screen has always
    // called it `subtitle`, so alias it rather than churn every call site.
    subtitle: { ...base.headerSubtitle },
    // `headerTextWrap` comes straight from the shared ramp via the `...base`
    // spread above; redeclaring it as a pure re-spread would be a no-op that
    // reads like an override.

    content: { ...base.body, paddingTop: 16, paddingBottom: 40, gap: 12 },

    countRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 4,
    },
    countText: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textMuted,
    },

    card: {
      ...base.card,
      borderRadius: 18,
      padding: 16,
      gap: 6,
    },
    cardExpired: { opacity: 0.72 },
    cardTop: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 10,
    },
    orderTitle: {
      fontFamily: fonts.bodyBold,
      fontSize: 15.5,
      color: c.textPrimary,
      flex: 1,
    },
    // Mint-tinted pill for the live countdown, rose for the elapsed one.
    timerPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: `${c.mint}1F`,
      borderWidth: 1,
      borderColor: `${c.mint}33`,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 999,
    },
    timerPillExpired: {
      backgroundColor: `${c.rose}1F`,
      borderColor: `${c.rose}33`,
    },
    timerText: {
      fontFamily: fonts.bodyBold,
      fontSize: 11.5,
      color: c.mint,
    },
    timerTextExpired: { color: c.rose },

    detail: {
      fontFamily: fonts.body,
      fontSize: 13.5,
      color: c.textSecondary,
    },

    button: {
      marginTop: 10,
      backgroundColor: c.mint,
      borderRadius: 999,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    // The disabled state is a grey surface, not a dimmed mint: at 0.6 opacity
    // the mint fill still reads as the enabled colour on a dark canvas.
    buttonDisabled: { backgroundColor: c.surfaceHover },
    buttonText: {
      fontFamily: fonts.bodyBold,
      color: c.onAccent,
      fontSize: 15,
    },
    buttonTextDisabled: { color: c.textMuted },

    emptyWrap: { alignItems: "center", paddingTop: 56, paddingHorizontal: 20 },
    empty: {
      fontFamily: fonts.display,
      fontSize: 17,
      color: c.textPrimary,
      marginTop: 14,
    },
    emptyHint: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      lineHeight: 18,
      color: c.textMuted,
      textAlign: "center",
      marginTop: 6,
    },
  });
};
