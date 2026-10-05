import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Animated,
  StatusBar,
  Platform,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { useProfile } from "../contexts/ProfileContext";
import { removeChannelSafe, uniqueTopic } from "../lib/realtime";
import { getEdgeFunctionName } from "../lib/env";
import { getEdgeFunctionErrorMessage } from "../lib/edgeFunctions";
import { useNotification } from "../contexts/NotificationContext";
import { useTheme } from "../contexts/ThemeContext";
import { EmptyState } from "../components/ui";
import ComplaintSheet from "../components/ComplaintSheet";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import { fonts } from "../components/theme";
import {
  formatOrderStatusLabel,
  isRealStatus,
  resolveOrderStatus,
} from "../lib/orderStatus";
import { fetchNamedTopups } from "../lib/superAgentRoster";

const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

// A money value that may genuinely be UNKNOWN, rendered so an unknown reads as
// unknown.
//
// `formatGhc` maps `null`, `undefined` and `""` all to `0`, because a genuine
// zero must render as "Ghc 0.00". That same fallback makes a MISSING figure
// indistinguishable from a measured zero - and in a settlement breakdown the
// difference is the whole point of the panel.
//
// The distinction this preserves, concretely:
//
//   transaction_fee on a WALLET order  - genuinely 0.00. No Paystack charge; the
//     money came from a balance that was charged once at top-up. "Ghc 0.00" is a
//     real, useful fact.
//   base_amount when the payment join failed - unknown, and rendering it as
//     "Ghc 0.00" would report a settlement figure nobody measured.
const formatGhcOptional = (value) => {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `Ghc ${parsed.toFixed(2)}` : "—";
};

// Status selection is delegated to `lib/orderStatus.js`, which explains why a
// plain `jehuca_order_status || status` chain is wrong: the corrupt boolean
// string "true" is truthy, so it wins the `||` and then fails the real-status
// test, rendering "Unknown" for an order whose real internal status was sitting
// unread in the very next field.

// Provider order ids that came back 404 have aged out of the provider's
// ~10-order retention window and will 404 forever, so warning on every refresh
// for every such order is pure noise (the log filled with identical lines).
// Log each id once, then stay quiet. Capped so a long-lived session with many
// dead orders cannot grow this without bound.
const warnedMissingProviderOrders = new Set();
const WARNED_ORDER_CAP = 200;

const warnProviderOrderMissingOnce = (orderId) => {
  if (warnedMissingProviderOrders.has(orderId)) return false;
  if (warnedMissingProviderOrders.size >= WARNED_ORDER_CAP) {
    warnedMissingProviderOrders.clear();
  }
  warnedMissingProviderOrders.add(orderId);
  console.warn(
    "Jehucal status request failed: Not Found 404 for provider order",
    orderId,
    "- the provider only retains its 10 most recent orders, so this status is unrecoverable.",
  );
  return true;
};

/**
 * Refreshes the provider status for a set of order rows and mirrors it back
 * into the database.
 *
 * `table` is the table the rows came from ("orders" or "agent_orders"). The
 * client write-back is a FALLBACK for the production `check-order-status`
 * build, which still runs the old code until it is deployed; the deployed
 * build syncs all three tables server-side and reports `synced`. See the note
 * on the write-back below.
 */
const refreshProviderStatuses = async (orders, table) => {
  const results = await Promise.all(
    (orders || []).map(async (order) => {
      if (!order.jehuca_order_id) return order;

      try {
        const { data, error } = await supabase.functions.invoke(
          getEdgeFunctionName("check-order-status"),
          { body: { orderId: order.jehuca_order_id } },
        );
        if (error) {
          if (
            getEdgeFunctionName("check-order-status") !== "check-order-status"
          ) {
            const fallback = await supabase.functions.invoke(
              "check-order-status",
              { body: { orderId: order.jehuca_order_id } },
            );
            if (!fallback.error) {
              // Same rule as the primary path: read the normalised
              // orderStatus, never the provider's boolean `status`.
              const fallbackStatus =
                fallback.data?.orderStatus ||
                fallback.data?.providerOrderStatus ||
                (typeof fallback.data?.status === "string"
                  ? fallback.data.status
                  : null);
              if (!isRealStatus(fallbackStatus)) return order;
              return {
                ...order,
                jehuca_order_status: fallbackStatus,
              };
            }
          }
          return order;
        }
        if (data?.success === false) {
          // A 404 is TERMINAL, not transient: the order has fallen out of the
          // provider's retention window and no retry can recover it. Warn once
          // per order id instead of once per order per refresh. Everything else
          // (balance errors, network blips) stays a per-refresh warning because
          // those genuinely are worth retrying.
          if (data?.notFound || data?.providerStatusCode === 404) {
            warnProviderOrderMissingOnce(order.jehuca_order_id);
          } else {
            console.warn(
              "Jehucal status request failed:",
              data.error,
              data.providerStatusCode,
            );
          }
          // The stored status is deliberately left alone. A previously-synced
          // COMPLETED must not be erased by a later 404.
          return order;
        }

        // The edge function normalises the real provider status onto
        // `orderStatus` / `providerOrderStatus`. Those are the ONLY fields
        // that hold an order status.
        //
        // The bare `data.status` is the provider's success BOOLEAN (`true`),
        // not a status string, and this chain used to fall all the way through
        // to it - so the card rendered "true" as the order status. A boolean
        // can never be a valid status, so reject it explicitly rather than
        // relying on it not being reached.
        const providerStatus =
          data?.orderStatus ||
          data?.providerOrderStatus ||
          data?.payload?.packages?.[0]?.status ||
          data?.payload?.status ||
          (typeof data?.status === "string" ? data.status : null);

        if (!isRealStatus(providerStatus)) return order;

        // `synced === true` means the deployed function already wrote the
        // status server-side, to every table carrying this provider id
        // (agent_orders, orders AND payment_transactions). Writing again from
        // here is redundant - and keeping two writers is how the field drifted
        // from the provider in the first place. `undefined` means the response
        // came from the OLD production build, which has no server-side sync,
        // so the write-back below is the only persistence path there.
        if (data?.synced === true) {
          return { ...order, jehuca_order_status: providerStatus };
        }

        if (providerStatus !== order.jehuca_order_status) {
          const { error: writeError } = await supabase
            .from(table)
            .update({ jehuca_order_status: providerStatus })
            .eq("id", order.id);
          if (writeError) {
            // This fallback write needs the caller to pass RLS on the row. It
            // can silently no-op (anon key + RLS) for some table/account
            // combinations, and a silent write failure is how the stored
            // status drifted from the provider in the first place. Log it
            // rather than pretending the write landed.
            console.warn(
              "Could not persist the provider status locally:",
              table,
              order.id,
              writeError.message,
            );
          }
        }

        return { ...order, jehuca_order_status: providerStatus };
      } catch (error) {
        console.warn("Unable to refresh Jehuca status:", error);
        return order;
      }
    }),
  );

  return results;
};

export default function HistoryScreen({ navigation }) {
  const { c, isDark, statusTone: tones } = useTheme();
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const s = useHistoryStyles(c, topInset);
  // Clears the floating bottom dock so the last order row stays reachable.
  const dockPadding = useDockBottomPadding(12);

  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isAgent, setIsAgent] = useState(false);
  const [isSuperAgentUser, setIsSuperAgentUser] = useState(false);
  const [reorderingId, setReorderingId] = useState(null);
  // The order the super agent is currently disputing. Null when the sheet is
  // closed. One object rather than a boolean so the sheet is always given the
  // row it belongs to - reopening for a different order must not show the
  // previous one's details.
  const [complaintOrder, setComplaintOrder] = useState(null);
  const { showError, showSuccess } = useNotification();
  const { isSuperAgent: isSuperAgentProfile, isSubAgent: isAgentProfile } =
    useProfile();
  const skeletonOpacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    checkAgentStatus();

    // Add listener to refresh when returning to screen
    const unsubscribe = navigation.addListener("focus", () => {
      // Re-check agent status and fetch transactions when returning to screen
      checkAgentStatus(true);
    });

    return unsubscribe;
  }, [navigation]);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(skeletonOpacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(skeletonOpacity, {
          toValue: 0.6,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [skeletonOpacity]);

  // Real-time updates for orders
  useEffect(() => {
    let historyChannel = null;
    let cancelled = false;

    const setupRealtimeSubscriptions = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        // From the profile context (`public.user_profiles`), NOT
        // `isSuperAgent(user)`. The old call was left over from the metadata
        // era: `isSuperAgent` was no longer imported here, so it threw a
        // `ReferenceError` that the `catch` below swallowed into a console log -
        // meaning the realtime channel was NEVER created and this screen's
        // live order updates silently did not work.
        //
        // Importing the predicate would not have fixed it either: it takes a
        // PROFILE now, and `user` here is an auth user, which folds to
        // "NormalUser" and would have reported every super agent as a customer.
        const isAssignedSuperAgent = isSuperAgentProfile;
        const channel = supabase.channel(
          uniqueTopic("history_orders_realtime"),
        );

        // Register every callback before subscribing. Supabase Realtime does
        // not allow adding postgres_changes callbacks after subscribe().
        channel.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "orders",
            filter: `user_id=eq.${user.id}`,
          },
          () => checkAgentStatus(true),
        );

        channel.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "agent_orders",
            filter: `agent_id=eq.${user.id}`,
          },
          () => checkAgentStatus(true),
        );

        if (isAssignedSuperAgent) {
          channel.on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "agent_orders",
              filter: `super_agent_id=eq.${user.id}`,
            },
            () => checkAgentStatus(true),
          );

                  // A sub-agent's WALLET-funded order lands in `orders`, not
                  // `agent_orders`, so the subscription above never fires for it. Without
                  // this leg the new orders branch would populate on open but stay stale
                  // while the screen was already mounted - the live list silently
                  // disagreeing with the ledger page, which is the same two-screens
                  // disagreeing symptom again, just one refresh later.
                  //
                  // Gated on the SAME `super_agent_id` column the read filters on, so the
                  // subscription and the query can never select different sets: a row the
                  // query cannot see will not trigger a reload, and a row it can see
                  // always will.
                  channel.on(
                    "postgres_changes",
                    {
                      event: "*",
                      schema: "public",
                      table: "orders",
                      filter: `super_agent_id=eq.${user.id}`,
                    },
                    () => checkAgentStatus(true),
                  );
                }

        historyChannel = channel;
        channel.subscribe();
      } catch (error) {
        console.error("Error setting up orders realtime subscriptions:", error);
      }
    };

    setupRealtimeSubscriptions();

    return () => {
      cancelled = true;
      // `historyChannel` may still be null if the effect was cleaned up during
      // the awaits above; the channel is then leaked and the next mount
      // collides with it. `removeChannelSafe` also no-ops on null.
      removeChannelSafe(historyChannel);
      historyChannel = null;
    };
  }, []);

  const checkAgentStatus = async (isRefresh = false) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        // Role from `public.user_profiles` via the profile context. The old code
        // read `user_metadata.role` and `user_metadata.super_agent_id`, both
        // writable by the account owner via `auth.updateUser()`.
        setIsSuperAgentUser(isSuperAgentProfile);
        const agentStatus = isAgentProfile;
        setIsAgent(agentStatus);

        // Fetch transactions after determining agent status
        fetchTransactions(agentStatus, isRefresh);
      }
    } catch (error) {
      console.error("Error checking agent status:", error);
      setIsAgent(false);
      fetchTransactions(false, isRefresh);
    }
  };

  const fetchTransactions = async (
    agentStatus = isAgent,
    isRefresh = false,
  ) => {
    try {
      if (!isRefresh) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        let allTransactions = [];

        // Fetch regular orders
        const { data: regularOrders, error: regularError } = await supabase
          .from("orders")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });

        if (regularError) {
          console.error("Error fetching regular orders:", regularError);
        } else {
          // Regular orders carry their own `jehuca_order_id`. They were
          // previously NEVER refreshed, so a normal user or a super agent's own
          // wallet purchase kept whatever status was written at dispatch time
          // even after the provider had moved it to COMPLETED.
          const refreshedRegularOrders = await refreshProviderStatuses(
            regularOrders,
            "orders",
          );
          const normalizedRegularOrders = refreshedRegularOrders.map(
            (order) => ({
              ...order,
              orderType: "regular",
              displayName: order.user_name,
              displayPhone: order.phone,
            }),
          );
          allTransactions = [...allTransactions, ...normalizedRegularOrders];
        }

        // If user is an agent, fetch agent orders too
        if (agentStatus) {
          const { data: agentOrders, error: agentError } = await supabase
            .from("agent_orders")
            .select("*")
            .eq("agent_id", user.id)
            .order("created_at", { ascending: false });

          if (agentError) {
            console.error("Error fetching agent orders:", agentError);
          } else {
            const refreshedAgentOrders = await refreshProviderStatuses(
              agentOrders,
              "agent_orders",
            );
            const normalizedAgentOrders = refreshedAgentOrders.map((order) => ({
              ...order,
              orderType: "agent",
              displayName: order.recipient_name,
              displayPhone: order.recipient_phone,
            }));
            allTransactions = [...allTransactions, ...normalizedAgentOrders];
          }
        }

        if (isSuperAgentProfile) {
          // Wallet top-ups, named.
          //
          // "My sub-agents' activity" was orders only, so the one movement that
          // is unambiguously about MONEY IN was missing from the list a super
          // agent uses to check money in. A top-up is also the only roster event
          // with no `agent_orders` row, so it cannot appear through any of the
          // order branches above.
          //
          // Named rows rather than raw ones: `wallet_topups` is keyed on the
          // payer's uuid, and an unnamed top-up renders as a uuid in the middle
          // of a financial list.
          try {
            const namedTopups = await fetchNamedTopups({
              superAgentId: user.id,
            });

            const topupTransactions = namedTopups.map((topup) => ({
              ...topup,
              orderType: "topup",
              source: "wallet_topup",
            }));
            allTransactions = [...allTransactions, ...topupTransactions];
          } catch (topupError) {
            // Non-fatal by design. A denied `wallet_topups` read returns HTTP
            // 200 with zero rows rather than an error, so this catch only fires
            // on a transport failure - but it must not blank the orders already
            // loaded, which are the primary content of this screen.
            console.error("Error fetching wallet top-ups:", topupError);
          }

          // Declared OUTSIDE the `else` below, and mutated rather than shadowed.
                    //
                    // The wallet-order branch that follows needs this same map, and it must
                    // run even when `assignedError` fired - a denied `agent_orders` read
                    // must not blank the wallet orders or strip their sub-agent names.
                    // Declaring it inside the `else` would put it in that block's scope,
                    // where the branch below cannot see it: a `ReferenceError` on every
                    // super agent whose Paystack read succeeded.
                    let subAgentBusinessNames = new Map();

                    const { data: assignedOrders, error: assignedError } = await supabase
                      .from("agent_orders")
                      .select("*")
                      .eq("super_agent_id", user.id)
                      .order("created_at", { ascending: false });

          if (assignedError) {
            console.error("Error fetching sub-agent orders:", assignedError);
          } else {
            const refreshedAssignedOrders = await refreshProviderStatuses(
              assignedOrders,
              "agent_orders",
            );
            const subAgentFunctionName = getEdgeFunctionName(
              "super-agent-user-management",
            );
            let subAgentResult = await supabase.functions.invoke(
              subAgentFunctionName,
              { body: { action: "listUsers", superAgentId: user.id } },
            );
            if (
              subAgentResult.error &&
              subAgentFunctionName !== "super-agent-user-management"
            ) {
              subAgentResult = await supabase.functions.invoke(
                "super-agent-user-management",
                { body: { action: "listUsers", superAgentId: user.id } },
              );
            }
            const subAgentData = subAgentResult.data;
            const subAgentError = subAgentResult.error;
            if (subAgentError) {
              console.error("Error fetching sub-agent names:", subAgentError);
            }
            subAgentBusinessNames = new Map(
              (subAgentData?.users || []).map((subAgent) => [
                subAgent.id,
                subAgent.user_metadata?.business_name || "",
              ]),
            );
            const assignedTransactions = refreshedAssignedOrders.map(
              (order) => ({
                ...order,
                orderType: "agent",
                isSubAgentTransaction: true,
                subAgentBusinessName:
                  subAgentBusinessNames.get(order.agent_id) || "",
                displayName: order.recipient_name,
                displayPhone: order.recipient_phone,
              }),
            );
            allTransactions = [...allTransactions, ...assignedTransactions];
          }

                      // -------------------------------------------------------------------------
                      // Wallet-funded sub-agent orders.
                      // -------------------------------------------------------------------------
                      // THE THIRD ORDER BRANCH, and the one whose absence is the reported bug.
                      //
                      // The two branches above cover the Paystack path only:
                      //
                      //   1. `orders`      WHERE user_id = me        - my own purchases
                      //   2. `agent_orders` WHERE agent_id = me      - orders I placed as a sub-agent
                      //   3. `agent_orders` WHERE super_agent_id = me - my sub-agents' Paystack orders
                      //
                      // A sub-agent's WALLET-funded order is in NONE of them. `verify-payment`
                      // writes it to `orders`, not `agent_orders` (the money came from a
                      // mirrored balance rather than a Paystack charge), so branch 3 matched
                      // no row and the order was simply absent from this list - with no error
                      // to distinguish it from "no orders yet". The Ledger page still showed
                      // the movement, because `super_agent_wallet_ledger` is keyed on the
                      // WALLET HOLDER rather than the order table - which is exactly why the
                      // two screens disagreed.
                      //
                      // Scoped on `orders.super_agent_id`, which `verify-payment` stamps from
                      // the resolved owner and migration 20261005_001 back-fills for historic
                      // rows. Requires that migration AND its `orders_read_by_super_agent`
                      // policy; before it the read returns `[]` rather than an error, so this
                      // branch degrades quietly and the other three are unaffected.
                      //
                      // `isSubAgentTransaction` and `subAgentBusinessName` mirror branch 3
                      // exactly, so these rows are indistinguishable in the UI from the
                      // Paystack orders beside them - same grouping, same labels, same empty
                      // state. They are marked `orderType: "regular"` because that is
                      // genuinely what they are: rows in `orders`, not `agent_orders`. Every
                      // consumer of this flag (the reorder action, the status picker) treats
                      // "regular" correctly, so tagging them "agent" would offer controls that
                      // act on the wrong table.
                      //
                      // Per-source try/catch, like the top-up branch above: one denied read
                      // must not blank the orders already loaded.
                      try {
                        const { data: walletOrders, error: walletOrdersError } = await supabase
                          .from("orders")
                          .select("*")
                          .eq("super_agent_id", user.id)
                          .order("created_at", { ascending: false });

                        if (walletOrdersError) {
                          console.error(
                            "Error fetching sub-agent wallet orders:",
                            walletOrdersError,
                          );
                        } else {
                          const refreshedWalletOrders = await refreshProviderStatuses(
                            walletOrders,
                            "orders",
                          );

                          // THE SETTLEMENT JOIN. `orders` does not carry the money split.
                          //
                          // Every figure the settlement breakdown renders lives on
                          // `payment_transactions` - `gross_amount`, `base_amount`,
                          // `transaction_fee`, `main_account_amount`, `super_agent_amount` -
                          // and `orders` has no settlement of its own. `verify-payment` writes
                          // the wallet branch's split onto the PAYMENT row and leaves the
                          // order row carrying only lifecycle columns.
                          //
                          // Without this join the breakdown read three `undefined`s and
                          // rendered `formatGhc(undefined)` = "Ghc 0.00" for every wallet
                          // purchase: a confident zero rather than a missing value, which is
                          // worse than showing nothing.
                          //
                          // `super_agent_amount` is the column that matters here, and it is
                          // genuinely 0 for a wallet order - `verify-payment` never sets it on
                          // that branch. The super agent's real money movement is
                          // `gross_amount - base_amount` (the markup the sub-agent charged
                          // over the admin base price the wallet was drawn down by), so the
                          // breakdown below derives "Amount received" from THAT rather than
                          // reading a column the writer leaves unset.
                          //
                          // Joined on `order_id` AND scoped to `order_type = 'regular'`.
                          // `orders` and `agent_orders` have INDEPENDENT id sequences, so a
                          // bare `order_id` match can pair this row with an unrelated agent
                          // order's payment and display the wrong money. `order_type` is the
                          // only thing that says which table the payment settled against.
                          //
                          // Per-source: a denied read of `payment_transactions` leaves the
                          // wallet orders visible with no settlement figures, rather than
                          // dropping the orders themselves.
                          let paymentsByOrderId = new Map();
                          const walletOrderIds = refreshedWalletOrders.map(
                            (order) => order.id,
                          );
                          if (walletOrderIds.length > 0) {
                            try {
                              const { data: walletPayments, error: walletPaymentsError } =
                                await supabase
                                  .from("payment_transactions")
                                  .select(
                                    "order_id, order_type, gross_amount, base_amount, transaction_fee, main_account_amount, super_agent_amount, settlement_status",
                                  )
                                  .eq("order_type", "regular")
                                  .in("order_id", walletOrderIds);

                              if (walletPaymentsError) {
                                console.error(
                                  "Error fetching wallet order settlements:",
                                  walletPaymentsError,
                                );
                              } else {
                                paymentsByOrderId = new Map(
                                  (walletPayments || []).map((payment) => [
                                    payment.order_id,
                                    payment,
                                  ]),
                                );
                              }
                            } catch (walletPaymentsCatch) {
                              console.error(
                                "Error fetching wallet order settlements:",
                                walletPaymentsCatch,
                              );
                            }
                          }

                          const walletTransactions = refreshedWalletOrders.map((order) => {
                            const payment = paymentsByOrderId.get(order.id) || null;
                            return {
                              ...order,
                              orderType: "regular",
                              isSubAgentTransaction: true,
                              subAgentBusinessName: subAgentBusinessNames.get(order.user_id) || "",
                              // `orders` names the buyer on `user_id` and carries the recipient
                              // on `phone` - the same shape branch 1 reads, and deliberately
                              // NOT the `recipient_*` columns `agent_orders` uses. The two tables
                              // were never the same shape.
                              displayName: order.user_name,
                              displayPhone: order.phone,
                              // The amount the SUB-AGENT paid, for the breakdown's
                              // "Customer payment" row. `orders.amount` is the same figure
                                                            // and is a sound fallback: it is the sale price the order
                                                            // was created with, not a settlement figure nobody
                                                            // measured.
                                                            gross_amount: payment?.gross_amount ?? order.amount ?? null,
                                                            // What the super agent's wallet was actually drawn down by:
                                                            // the admin-set base price.
                                                            //
                                                            // `null` when unknown, NEVER defaulted to 0. A zero here
                                                            // would flow into the derivation below as "the sale price
                                                            // IS the margin", inventing a profit figure that was never
                                                            // recorded - and `formatGhc` would render it as a
                                                            // confident number.
                                                            base_amount: payment?.base_amount ?? null,
                                                            // Always 0 on a wallet order - the money came from a mirrored
                                                            // balance charged once at top-up, so there is no per-order
                                                            // provider fee. 0 is a REAL value here, not a stand-in for
                                                            // missing, so it is preserved rather than nulled.
                                                            transaction_fee: payment?.transaction_fee ?? 0,
                                                            // What the platform took: the sale price less the base price.
                                                            main_account_amount: payment?.main_account_amount ?? null,
                                                            settlement_status: payment?.settlement_status ?? null,
                                                            // Derived, NOT `payment.super_agent_amount` - that column is
                                                            // unset on the wallet branch, so reading it reported a
                                                            // margin of zero for every purchase.
                                                            //
                                                            // Requires BOTH operands. `gross - base` is only the markup
                                                            // when both are known; defaulting a missing base to 0
                                                            // would make the whole sale price look like profit, which
                                                            // is the exact conflation this screen's own header warns
                                                            // against. When either is unknown the margin is unknown,
                                                            // and it is rendered as "—" rather than as a number.
                                                            super_agent_share: (() => {
                                                              if (!payment) return null;
                                                              const gross = Number(payment.gross_amount);
                                                              const base = Number(payment.base_amount);
                                                              if (
                                                                !Number.isFinite(gross) ||
                                                                !Number.isFinite(base)
                                                              ) {
                                                                return null;
                                                              }
                                                              return Number((gross - base).toFixed(2));
                                                            })(),
                                                          };
                          });
                          allTransactions = [
                            ...allTransactions,
                            ...walletTransactions,
                          ];
                        }
                      } catch (walletOrdersCatch) {
                        console.error(
                          "Error fetching sub-agent wallet orders:",
                          walletOrdersCatch,
                        );
                      }
                    }

        // Sort all transactions by created_at
        allTransactions.sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at),
        );

        setTransactions(allTransactions);
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    checkAgentStatus(true);
  };

    // On web this route can be entered cold - deep link, reload, bookmark - in
    // which case there is nothing behind it in the stack and `goBack()` warns
    // that no navigator handled it. Falls back to Home. Mirrors the guard on
    // ProfileScreen and NotificationsScreen.
    const handleBack = () => {
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.navigate("Home");
    };

  const reorderHeldOrder = async (order) => {
    setReorderingId(order.id);
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
          data?.error || "Could not reorder held order.",
        );
        throw new Error(message);
      }
      showSuccess("Order Reordered", "The package was sent to Jehucal.");
      await checkAgentStatus(true);
    } catch (error) {
      console.error("Held order reorder failed:", error);
      showError("Reorder Failed", error.message || "Could not reorder order.");
    } finally {
      setReorderingId(null);
    }
  };

  // Status presentation now comes from the shared tone map, which is
  // scheme-aware - the old hardcoded hexes were tuned for white cards only.
  // "held" (super agent orders awaiting reorder) and "expired" (flipped by the
  // 24h sweep) have no entry in the shared map, so they borrow the pending and
  // cancelled families respectively and keep their own label.
  const statusToneOf = (status) => {
    if (!isRealStatus(status)) {
      return { label: undefined, color: c.textMuted, bg: c.surfaceHover };
    }
    const key = String(status || "").toLowerCase();
    if (key === "held") return { ...tones.pending, label: "Held" };
    if (key === "delivered") return { ...tones.completed, label: "Delivered" };
    if (key === "expired") return { ...tones.cancelled, label: "Expired" };
    return (
      tones[key] || { label: undefined, color: c.textMuted, bg: c.surfaceHover }
    );
  };

  // See `lib/orderStatus.js` - booleans are rejected there, and an unrecoverable
  // status honestly renders as "Unknown".
  const getStatusText = (status) => formatOrderStatusLabel(status);

  const formatDate = (dateString) => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const counts = useMemo(() => {
    const acc = { total: transactions.length, completed: 0, pending: 0 };
    transactions.forEach((transaction) => {
      // Same resolver the card and receipt use, so the summary tiles can never
      // disagree with the rows they summarise.
      const key = String(resolveOrderStatus(transaction) || "").toLowerCase();
      if (key === "completed" || key === "delivered") acc.completed += 1;
      else if (key === "pending" || key === "processing" || key === "held")
        acc.pending += 1;
    });
    return acc;
  }, [transactions]);

  return (
    <View style={s.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      <ScrollView
        contentContainerStyle={[
          s.scrollContent,
          { paddingBottom: dockPadding },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.mint}
            colors={[c.mint]}
            progressBackgroundColor={c.surface}
          />
        }
      >
        <View style={s.header}>
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
          <View style={s.headerTextWrap}>
                    {/* Eyebrow above the title: the screen's job, stated, so the count
                        below reads as a figure on a statement rather than as the whole
                        purpose of the page. */}
                    <Text style={s.headerEyebrow}>Statement</Text>
                    <Text style={s.headerTitle}>Transaction History</Text>
                  </View>
                  <Text style={s.headerCount}>
                    {counts.total === 0 ? "—" : counts.total}
                  </Text>
                </View>

        {/* Summary strip - only meaningful once there is something to summarise.

                    Label above value rather than below: a statement reads top-down, and
                    the label tells you what the number IS before you meet it. The
                    third tile is set apart because "Total" is the number people came
                    for; the other two are context for it. */}
                {!loading && counts.total > 0 ? (
                  <View style={s.summary}>
                    <SummaryTile
                      label="Settled"
                      value={counts.completed}
                      tone={tones.completed}
                      labelColor={c.textMuted}
                    />
                    <View style={s.summaryDivider} />
                    <SummaryTile
                      label="In flight"
                      value={counts.pending}
                      tone={tones.pending}
                      labelColor={c.textMuted}
                    />
                    <View style={s.summaryDivider} />
                    <SummaryTile
                      label="Orders"
                      value={counts.total}
                      tone={{ color: c.mint }}
                      labelColor={c.textSecondary}
                      last
                    />
                  </View>
                ) : null}

        {loading ? (
          <View style={s.list}>
            {[0, 1, 2, 3].map((index) => (
              <Animated.View
                key={`history-placeholder-${index}`}
                style={[s.placeholder, { opacity: skeletonOpacity }]}
              >
                <View style={s.placeholderBody}>
                  <View style={s.placeholderLine} />
                  <View style={s.placeholderLineShort} />
                </View>
                <View style={s.placeholderTail}>
                  <View style={s.placeholderAmount} />
                  <View style={s.placeholderBadge} />
                </View>
              </Animated.View>
            ))}
          </View>
        ) : transactions.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
                      title="Nothing on the statement yet"
                      message={
                        isSuperAgentUser
                          ? "Orders your sub-agents place — whether they pay by card or from a wallet balance — land here, along with every settlement split."
                          : "Your purchases will appear here once you buy a data bundle."
                      }
                    />
        ) : (
          <View style={s.list}>
            {transactions.map((transaction) => {
              // A wallet top-up is not an order: it has no network, no package,
              // no recipient and no settlement split. Without this branch it
              // would fall through to the order markup below and render "Ghc
              // 0.00", "Data Bundle" and a breakdown of five zeroes - all of
              // which read as real values rather than as absent data.
              const isTopup = transaction.source === "wallet_topup";
              const isSubAgent =
                !isTopup &&
                isSuperAgentUser &&
                transaction.isSubAgentTransaction;
                            // A sub-agent's WALLET-funded order is a real `orders` row and so
                            // carries `orderType: "regular"`. Both the title and the description
                            // branch on `orderType === "agent"`, so without this flag those rows
                            // fell through to the generic "Purchase" / "Data Bundle" wording and
                            // a super agent could not tell their sub-agent's purchase from their
                            // own - the two sitting in one list, identically labelled.
                            //
                            // `isSubAgent` alone is not enough to pick them out here: it is
                            // ALSO true for a Paystack sub-agent order, which legitimately IS
                            // `orderType: "agent"` and already reads correctly. This flag marks
                            // only the wallet-funded shape.
                            const isSubAgentWalletOrder =
                              isSubAgent && transaction.orderType !== "agent";
                                          // BOTH status columns, resolved independently - see the note on the
                                          // card's status block below. `displayStatus` above is the RESOLVED
                                          // status (provider preferred), which is right for the spine colour
                                          // but wrong for a row that claims to show two sources.
                                          const cardInternalStatus = isRealStatus(transaction.status)
                              ? transaction.status.trim()
                              : null;
                                          const cardProviderStatus = isRealStatus(
                              transaction.jehuca_order_status,
                                          )
                              ? transaction.jehuca_order_status.trim()
                              : null;
              // Resolved once and reused for the pill's colour AND its label,
              // so the two can never come from different fields.
              const displayStatus = resolveOrderStatus(transaction);
              // `wallet_topups.status` is Paystack's vocabulary ('pending' |
              // 'success' | 'failed'), not the order vocabulary the tone map is
              // keyed on. Left unmapped here so a top-up is never dressed in an
              // order's wording; it gets its own label further down.
              const tone = isTopup
                ? null
                : statusToneOf(displayStatus);
              const statusLabel = tone?.label || getStatusText(displayStatus);
              const held = String(transaction.status).toLowerCase() === "held";

              const topupTone = (() => {
                const key = String(transaction.status || "").toLowerCase();
                if (key === "success") return tones.completed;
                if (key === "failed") return tones.failed;
                return tones.pending;
              })();

              return (
                              <View
                  key={`${transaction.source || transaction.orderType}-${transaction.id}`}
                                style={s.cardShell}
                              >
                                {/* THE STATUS SPINE.
                                    A 3px rule down the left edge in the status colour, so the
                                    list can be scanned vertically: which orders are stuck is
                                    answerable from the left margin alone, without reading a
                                    single word. On a reconciliation screen that is the single
                                    most valuable thing a layout can do.

                                    It replaces nothing - the status pill stays in the panel -
                                    because a colour bar is not readable on its own for a
                                    colourblind user, and the panel carries the words. */}
                                <View
                                  style={[
                                    s.cardSpine,
                                    {
                                      backgroundColor:
                                        isTopup ? topupTone.color : tone?.color || c.hairline,
                                    },
                                  ]}
                                />
                                <TouchableOpacity
                                  style={s.card}
                                  activeOpacity={0.86}
                                  onPress={() =>
                                    navigation.navigate("Receipt", { transaction })
                                  }
                                  accessibilityRole="button"
                                  accessibilityLabel={`${statusLabel} order, ${formatDate(transaction.created_at)}`}
                                >
                                <View style={s.cardHeader}>
                                  <View style={s.cardHeadText}>
                      <Text style={s.cardTitle} numberOfLines={1}>
                        {isTopup
                          ? `Wallet top-up · ${
                              transaction.subAgentName || "Sub-agent"
                            }`
                          : transaction.orderType === "agent"
                            ? `${
                                transaction.isSubAgentTransaction
                                  ? "Sub-agent order"
                                  : "Agent service"
                              } · ${
                                transaction.isSubAgentTransaction
                                  ? transaction.subAgentBusinessName ||
                                    "Sub-agent"
                                  : transaction.displayPhone || "Customer"
                              }`
                                                      : isSubAgentWalletOrder
                                                        // Says "wallet" rather than "order" for the same
                                                        // reason the transactions screen labels these
                                                        // "Wallet Purchase": the money came from a mirrored
                                                        // balance, not a Paystack charge, and the
                                                        // distinction is what a super agent reconciles
                                                        // against.
                                                        ? `Sub-agent wallet purchase · ${
                                                            transaction.subAgentBusinessName || "Sub-agent"
                                                          }`
                                                        : transaction.offer_title || "Purchase"}
                      </Text>
                      <Text style={s.cardDate}>
                        {formatDate(transaction.created_at)}
                      </Text>
                    </View>
                    {!isSubAgent ? (
                      <Text style={s.cardAmount}>
                        {isTopup
                          ? `+Ghc ${Number(transaction.amount || 0).toFixed(2)}`
                          : transaction.amount
                            ? `Ghc ${transaction.amount}`
                            : "N/A"}
                      </Text>
                    ) : null}
                  </View>

                  <Text style={s.cardDesc} numberOfLines={2}>
                    {isTopup
                      ? `${String(transaction.channel || "Wallet").toUpperCase()} funding`
                      : transaction.orderType === "agent"
                        ? transaction.isSubAgentTransaction
                          ? `${transaction.network || "Data"} · ${
                              transaction.recipient_phone ||
                              "Recipient unavailable"
                            }`
                          : `Phone: ${transaction.displayPhone || "N/A"}`
                        : isSubAgentWalletOrder
                                                ? `${transaction.network || "Data"} · ${
                          transaction.phone || "Recipient unavailable"
                                                  } · paid from wallet`
                                                : (transaction.network
                          ? `${transaction.network.toUpperCase()} - `
                          : "") +
                                                  (transaction.data_amount || "Data Bundle") +
                                                  (transaction.displayPhone
                          ? ` · ${transaction.displayPhone}`
                          : "")}
                  </Text>

                  {/* Sub-agent orders carry a settlement breakdown instead of a
                      top-level amount, so the status pill moves down here. */}
                  {/* A top-up is money IN and carries no settlement split, so it
                      gets a compact status pill of its own. `topupTone` is
                      resolved from `wallet_topups.status` rather than from
                      `tone`, which is null for these rows. */}
                  {isTopup ? (
                    <View style={s.cardFoot}>
                      <View
                        style={[s.pill, { backgroundColor: topupTone.bg }]}
                      >
                        <Text style={[s.pillText, { color: topupTone.color }]}>
                          {transaction.status === "success"
                            ? "Received"
                            : transaction.status === "failed"
                              ? "Failed"
                              : "Pending"}
                        </Text>
                      </View>
                      {transaction.reference ? (
                        <Text style={s.cardDate} numberOfLines={1}>
                          {transaction.reference}
                        </Text>
                      ) : null}
                    </View>
                  ) : isSubAgent ? (
                    <View style={s.breakdown}>
                                          {/* The eyebrow now owns its own line rather than sharing
                                              the row with the status pair.

                                              It previously sat beside it in `breakdownHead`, where
                                              both carried `flex: 1` and competed for the same width -
                                              so the "SUPER AGENT SETTLEMENT" caption was squeezed to
                                              a sliver while two status chips wrapped under it. The
                                              caption is structure, not content; the statuses are the
                                              information. Giving each a line means the caption reads
                                              in full and the statuses stay on one row together, which
                                              is the whole point of showing them side by side. */}
                                          <Text style={s.breakdownEyebrow}>
                                            Super agent settlement
                                          </Text>
                                          <View style={s.breakdownStatusRow}>
                                            <DualStatus
                                              s={s}
                                              internalStatus={cardInternalStatus}
                                              providerStatus={cardProviderStatus}
                                              toneOf={statusToneOf}
                                              labelOf={getStatusText}
                                            />
                                          </View>

                      <View style={s.breakdownRows}>
                        <BreakdownRow
                          label="Customer payment"
                          value={formatGhc(transaction.amount)}
                          labelColor={c.textMuted}
                        />
                                              {/* Only on the wallet shape: the super agent was drawn
                                                    down by the base price to fulfil this order. A
                                                    Paystack sub-agent order involves no wallet
                                                    draw-down, and rendering the row there would show a
                                                    meaningless zero. `!= null` so a genuine 0.00 base
                                                    price - a free or fully discounted package - still
                                                    renders rather than vanishing. */}
                                              {isSubAgentWalletOrder &&
                                              transaction.base_amount != null ? (
                                                  <BreakdownRow
                                                    label="Paid to platform"
                                                    value={formatGhcOptional(transaction.base_amount)}
                                                    labelColor={c.textMuted}
                                                  />
                                              ) : null}
                                              <BreakdownRow
                                                  label="Paystack fee"
                                                  value={formatGhcOptional(transaction.transaction_fee)}
                                                  tint={transaction.transaction_fee ? c.amber : undefined}
                                                  labelColor={c.textMuted}
                                              />
                                            </View>

                                            {/* The margin is the answer, so it gets the total row
                                                  rather than competing as a third line among its own
                                                  inputs. */}
                                            <BreakdownTotal
                                              label="Your margin"
                                              value={formatGhcOptional(transaction.super_agent_share)}
                                              labelColor={c.textMuted}
                                            />

                                              {/* The base price is what the super agent actually PAID the
                                                  platform to fulfil the order, so on a wallet order it is
                                                  the figure worth showing beside the markup - the two
                                                  numbers reconcile to the sale price above.

                                                  Scoped to the wallet shape rather than rendered
                                                  unconditionally: a Paystack sub-agent order involves no
                                                  wallet draw-down, and `orders`-shaped rows would show a
                                                  meaningless "Ghc 0.00" here.

                                                  `!= null` rather than a truthiness test, so a genuine 0.00
                                                  base price (a free or fully discounted package) still
                                                  renders rather than silently disappearing. */}
                                              {/* The panel's closing line.

                                                                                                                    `main_account_amount` is retained, but only where it says
                                                                                                                    something the margin row does not.

                                                                                                                    Paystack: `settlement.adminShare` - the platform's cut
                                                                                                                    of a real charge, genuinely distinct from the super
                                                                                                                    agent's share.

                                                                                                                    Wallet: `verify-payment` sets it to
                                                                                                                    `saleAmount - superAgentDebitAmount`, which is the
                                                                                                                    SAME figure as the margin row directly above it.
                                                                                                                    Printing it twice under two names would make the
                                                                                                                    panel look like it accounts for the sale price when
                                                                                                                    it does not, so on that shape it is dropped - the
                                                                                                                    panel already shows sale, base and margin, which
                                                                                                                    do reconcile. */}
                                                                                                                    {isSubAgentWalletOrder ||
                                                                                                                    transaction.main_account_amount == null ? null : (
                                                                                                                      <View style={s.breakdownFoot}>
                                                                                                                        <Text style={s.breakdownFootLabel}>
                                                                                                                          Fee kept by the platform
                                                                                                                        </Text>
                                                                                                                        <Text
                                                                                                                          style={[
                                                                                                                            s.breakdownFootValue,
                                                                                                                            { color: c.textPrimary },
                                                                                                                          ]}
                                                                                                                        >
                                                                                                                          {formatGhcOptional(transaction.main_account_amount)}
                                                                                                                        </Text>
                                                                                                                      </View>
                                                                                                                    )}
                                                                  </View>
                                                                ) : (
                    <View style={s.cardFoot}>
                                          {/* BOTH STATUSES, side by side.

                                              The single pill this replaced read the RESOLVED status,
                                              which prefers the provider's value whenever it is real.
                                              That is the right answer to "what state is this?" and
                                              the wrong one for the question this list actually gets
                                              asked: "is this order stuck?"

                                              The case that matters is `status = completed` while the
                                              provider still says `processing`. We think we finished,
                                              the data has not landed, and the old pill rendered it as
                                              settled - so a super agent scanning the list saw nothing
                                              wrong with an order that needed watching.

                                              Both columns are read independently and never fall back
                                              to each other: a row with no provider status yet says so
                                              rather than borrowing ours.

                                              Rendered by `DualStatus`, the same component the
                                              sub-agent branch uses - the two used to be separate
                                              pills, which is how one of them ended up still showing a
                                              single merged status. */}
                                          <DualStatus
                                            s={s}
                                            internalStatus={cardInternalStatus}
                                            providerStatus={cardProviderStatus}
                                            toneOf={statusToneOf}
                                            labelOf={getStatusText}
                                            showProvider={!isTopup}
                                            fill
                                          />
                                          <Ionicons
                                            name="chevron-forward"
                                            size={15}
                                            color={c.textMuted}
                                          />
                                        </View>
                                      )}

                  {isSubAgent && held ? (
                    <TouchableOpacity
                      style={s.reorderButton}
                      onPress={() => reorderHeldOrder(transaction)}
                      disabled={reorderingId === transaction.id}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="refresh" size={14} color={c.onAccent} />
                      <Text style={s.reorderText}>
                        {reorderingId === transaction.id
                          ? "Retrying…"
                          : "Reorder"}
                      </Text>
                    </TouchableOpacity>
                  ) : null}

                  {/* Report a problem. The card itself navigates to the
                      receipt, so the press has to stop here or the sheet opens
                      and the navigation fires too.

                      Excluded for top-ups. A wallet top-up is a Paystack charge
                      the super agent RECEIVED, not an order they sold; sending
                      it to support as "Order #<wallet_topups id>" would quote a
                      reference that does not exist on any order, and the id
                      space is shared with `agent_orders`, so it could match a
                      real, unrelated order. */}
                  {isSuperAgentUser && !isTopup ? (
                    <TouchableOpacity
                      style={s.complaintButton}
                      onPress={(event) => {
                        if (event?.stopPropagation) {
                          event.stopPropagation();
                        }
                        setComplaintOrder(transaction);
                      }}
                      activeOpacity={0.85}
                      accessibilityRole="button"
                      accessibilityLabel={`Report a problem with order ${transaction.id}`}
                    >
                      <Ionicons
                        name="logo-whatsapp"
                        size={14}
                        color={c.textSecondary}
                      />
                      <Text style={s.complaintText}>Report a problem</Text>
                    </TouchableOpacity>
                  ) : null}
                                        </TouchableOpacity>
                                      </View>
                                    );
                                  })}
          </View>
        )}
      </ScrollView>

      <ComplaintSheet
        visible={Boolean(complaintOrder)}
        order={complaintOrder}
        onClose={() => setComplaintOrder(null)}
        onError={(message) => showError("Cannot Open WhatsApp", message)}
      />
    </View>
  );
}

/**
 * Both status columns, side by side.
 *
 * The two columns are genuinely different facts - our internal state and the
 * provider's mirrored one - and they can disagree. Collapsing them via
 * `resolveOrderStatus` picks the provider's value whenever it is real, so a
 * card can only ever show one status, and the disagreement disappears:
 *
 *     ours = completed, provider = processing
 *
 * reads as settled when the data has not actually landed.
 *
 * `toneOf` and `labelOf` are PASSED IN rather than imported or re-derived,
 * because `statusToneOf` closes over the palette from `useTheme` and cannot be
 * lifted to module scope. Passing them keeps this component reading from the
 * exact same resolver the card's spine colour uses, so the chip and the edge
 * rule can never disagree.
 *
 * Neither column ever falls back to the other. A missing provider status is
 * absent data, and printing our own value in its place would recreate exactly
 * the silent duplication this component exists to remove.
 */
function DualStatus({
  s,
  internalStatus,
  providerStatus,
  toneOf,
  labelOf,
  showProvider = true,
  // Whether this pair shares a row with something else that it must not crowd
  // out. True in the card foot (the chevron lives beside it), false in the
  // settlement panel (it owns the line).
  fill = false,
}) {

  const track = (label, status) => (
    <View style={s.statusPairItem}>
      <Text style={s.statusPairLabel}>{label}</Text>
      {status ? (
        <View style={[s.pill, { backgroundColor: toneOf(status).bg }]}>
          <Text style={[s.pillText, { color: toneOf(status).color }]}>
            {labelOf(status)}
          </Text>
        </View>
      ) : (
        // An em dash rather than a pill: an unreported status is absent data,
        // and giving it a chip would make it weigh the same as a real one.
        <Text style={s.statusPairNone}>—</Text>
      )}
    </View>
  );

  return (
      <View style={[s.statusPair, fill ? { flex: 1 } : null]}>
      {track("Ours", internalStatus)}
      {showProvider ? track("Provider", providerStatus) : null}
    </View>
  );
}

/**
 * The dotted leader that carries a breakdown label across to its value.
 *
 * The device this screen is used on is a ledger. A super agent is reconciling
 * four figures that must add up to the one above them, and the fastest way to
 * check that by eye is to scan a vertical column of digits - which is only
 * possible if the values all start at the same x. The label therefore runs to a
 * fixed-width gutter and the leader fills the gap, so the numbers align the way
 * they do on a printed receipt regardless of how long the label is.
 *
 * Drawn as characters rather than `borderStyle: "dotted"`: dotted borders are
 * unreliable on Android (they render as solid, or not at all), and this screen
 * ships to native as well as web. Text degrades correctly everywhere, and the
 * leader is a fixed short run so it costs nothing.
 */
function Leader({ tint }) {
  const { c } = useTheme();
  return (
    <Text
      style={[styles.leader, { color: tint || c.hairlineStrong }]}
      numberOfLines={1}
    >
      · · · · · · · · · · · · · · · · · ·
    </Text>
  );
}

function SummaryTile({ label, value, tone, labelColor, last }) {
  return (
    <View style={styles.summaryTile}>
      <Text style={[styles.summaryLabel, { color: labelColor }]}>
        {label}
      </Text>
      {/* tabular-nums so the three figures share a digit width and read as
          columns. Proportional digits make "11" narrower than "8", which reads
          as jitter in a row of numbers. */}
      <Text
        style={[
          styles.summaryValue,
          { color: tone.color },
          last ? styles.summaryValueAccent : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

function BreakdownRow({ label, value, emphasis, tint, labelColor }) {
  // Colours resolved HERE, not at the call site.
  //
  // `styles.breakdownLabel` and `styles.breakdownValue` live in the module-level
  // `StyleSheet.create` - outside the `useThemedStyles` closure - so they cannot
  // read the palette and carry NO `color` at all. That left both texts on React
  // Native's default black.
  //
  // It read as "only profit is showing" because the value's colour arrived solely
  // from the `tint` prop, which only the "Amount received" row passes. Every
  // other row rendered black-on-dark: present in the DOM, invisible on screen.
  // The one tinted row was the one that appeared to work.
  //
  // The tint is applied LAST so an explicit `tint` still wins - the emphasis
  // colour is a deliberate override, not a fallback being clobbered.
  const { c } = useTheme();
  return (
    <View style={styles.breakdownRow}>
      <Text
        style={[styles.breakdownLabel, { color: labelColor || c.textMuted }]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Leader />
      <Text
        style={[
          styles.breakdownValue,
          emphasis ? styles.breakdownValueEmphasis : null,
          { color: tint || c.textPrimary },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * The total row of a settlement panel, set apart by a rule above it.
 *
 * Deliberately the largest figure in the panel: on a reconciliation screen the
 * one number a super agent is looking for is what they actually kept, and it
 * should not compete with the inputs that produced it.
 */
function BreakdownTotal({ label, value, labelColor }) {
  const { c } = useTheme();
  return (
    <View
            style={[
              styles.breakdownTotal,
              // The rule above the total uses the STRONG hairline, not the faint
              // one: this is the one structural boundary in the panel, separating
              // the inputs from the figure they produce.
              { borderTopColor: c.hairlineStrong },
            ]}
          >
          {/* `numberOfLines={1}` on the label, paired with `flexShrink` in the
              stylesheet: the style alone allows the text to wrap, and a two-line
              uppercase label is what pushes the amount down beneath it. */}
      <Text
        style={[styles.breakdownTotalLabel, { color: labelColor }]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text
        style={[styles.breakdownTotalValue, { color: c.mint }]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

// Cross-platform elevation. Mirrors HomeScreen/ProfileScreen: `boxShadow` for
// web (where `shadow*` flattens), native props elsewhere, palette tone.
const shadow = (elevation, shadowOpacity = 0.16, tone = "#000000") =>
  Platform.select({
    ios: {
      shadowColor: tone,
      shadowOffset: { width: 0, height: elevation },
      shadowOpacity,
      shadowRadius: elevation * 1.6,
    },
    android: { elevation },
    default: {
      boxShadow: `${tone}${Math.round(shadowOpacity * 255)
        .toString(16)
        .padStart(2, "0")} 0px ${elevation}px ${elevation * 1.8}px`,
    },
  });

const useHistoryStyles = (c, topInset) =>
  useMemo(() => buildStyles(c, topInset), [c, topInset]);

// `topInset` is the Android status-bar height. The app is edge-to-edge there
// and this screen draws its own header (no navigator header), so it must
// inset itself.
const buildStyles = (c, topInset = 0) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.canvas,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingBottom: 36,
    },

    /* ---------- Header ---------- */
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingTop: 8 + topInset,
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
        headerEyebrow: {
          fontFamily: fonts.bodySemi,
          fontSize: 9.5,
          color: c.mintDim,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          marginBottom: 3,
        },
        headerTitle: {
          fontFamily: fonts.display,
          fontSize: 22,
          color: c.textPrimary,
        },
        // The total, set in the display face at a size that reads as the screen's
        // headline figure. An em dash rather than "0" when empty: zero orders is not
        // the same claim as "nothing to count yet".
        headerCount: {
          fontFamily: fonts.displayBold,
          fontSize: 30,
          color: c.mint,
          fontVariant: ["tabular-nums"],
          lineHeight: 34,
        },

    /* ---------- Summary ---------- */
    summary: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.hairline,
      paddingVertical: 14,
      marginBottom: 18,
      ...shadow(3, 0.14, c.shadow),
    },
    summaryDivider: {
      width: StyleSheet.hairlineWidth,
      height: 28,
      backgroundColor: c.hairline,
    },

    /* ---------- Cards ---------- */
    list: {
      gap: 12,
    },
        // The spine sits outside the card's padding so the status colour reads as a
        // rule on the list rather than as part of the card's content. The shell is
        // transparent and clips the corner radii; `overflow: "hidden"` on the shell
        // is what rounds the spine's ends with the card rather than letting it run
        // square past them.
        cardShell: {
          borderRadius: 22,
          overflow: "hidden",
          ...shadow(4, 0.16, c.shadow),
        },
        cardSpine: {
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          zIndex: 2,
        },
        card: {
          backgroundColor: c.surface,
          borderWidth: 1,
          borderColor: c.hairline,
          borderLeftWidth: 0,
          padding: 16,
          paddingLeft: 19,
        },
    cardHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
    },
    cardHeadText: {
      flex: 1,
    },
    cardTitle: {
      fontFamily: fonts.bodySemi,
      fontSize: 15,
      color: c.textPrimary,
    },
    cardDate: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.textMuted,
      marginTop: 3,
    },
    cardAmount: {
      fontFamily: fonts.displayBold,
      fontSize: 16,
      color: c.textPrimary,
    },
    cardDesc: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textSecondary,
      marginTop: 8,
    },
    cardFoot: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 12,
    },

    /* ---------- Status pill ---------- */
    pill: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      alignSelf: "flex-start",
    },
        // The two status tracks, side by side. `flexWrap` so a long status word
        // drops to a second line rather than squeezing the chevron off the row.
        statusPair: {
          flexDirection: "row",
                  // Wraps rather than compresses: a long status word ("Processing")
                  // drops to a second line instead of forcing the pair to squeeze the
                  // chevron off the card foot, or truncating a status the reader needs.
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 6,
                  // `flex: 1` is set by the CALLER, not here. In the card foot the pair
                  // shares a row with the chevron and must not eat it; in the settlement
                  // panel it has a row to itself and must claim the full width. Baking
                  // `flex: 1` into the component made the panel variant leave half the
                  // line empty.
                },
        statusPairItem: {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
        },
        // Capitalised micro-label rather than an icon: "ours" vs "provider" is a
        // distinction of ownership, and a glyph does not convey it.
        statusPairLabel: {
          fontFamily: fonts.bodySemi,
          fontSize: 8.5,
          letterSpacing: 0.9,
          textTransform: "uppercase",
          color: c.textMuted,
        },
        // Em dash, not a pill: an unreported status is absent data, and drawing it
        // as a status chip would give it the same visual weight as a real one.
        statusPairNone: {
          fontFamily: fonts.body,
          fontSize: 12,
          color: c.textMuted,
          minWidth: 14,
        },
    pillText: {
      fontFamily: fonts.bodyBold,
      fontSize: 10,
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },

    /* ---------- Settlement breakdown ---------- */
    breakdown: {
      marginTop: 14,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.hairline,
      backgroundColor: c.surfaceSunken,
      padding: 14,
    },
    breakdownEyebrow: {
      fontFamily: fonts.bodySemi,
      fontSize: 9.5,
      color: c.mintDim,
      letterSpacing: 1.1,
      textTransform: "uppercase",
        },
        // Own line for the status pair inside a settlement panel. The card's own
        // footer has room for the pair beside the chevron; a panel does not, so it
        // needs the full width or the two chips wrap under each other.
        breakdownStatusRow: {
          flexDirection: "row",
          alignItems: "center",
          marginBottom: 12,
        },
    breakdownRows: {
          gap: 7,
          // Reserves the value column so the dotted leaders stop at the same x and
          // every figure below lines up. Without it the leader run is whatever the
          // remaining width happens to be, and the digits stagger per row.
          paddingRight: 4,
        },
        // NOTE: `breakdownTotal*` are NOT here. They live in the module-level
        // `styles` sheet, because `BreakdownTotal` is a standalone component that
        // cannot read the themed `useHistoryStyles(c, topInset)` closure. Defining
        // them here meant `styles.breakdownTotal` resolved to `undefined` on every
        // render - so the row silently fell back to a default `<View>`, which is
        // why the margin dropped beneath its label no matter what this file said.
    breakdownFoot: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 11,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.hairline,
    },
    breakdownFootLabel: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.textMuted,
    },
    breakdownFootValue: {
      fontFamily: fonts.bodyBold,
      fontSize: 12.5,
      color: c.textSecondary,
    },

    /* ---------- Reorder ---------- */
    reorderButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      height: 42,
      borderRadius: 999,
      backgroundColor: c.mint,
      marginTop: 12,
    },
    reorderText: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.onAccent,
    },

    /* ---------- Report a problem ---------- */
    // Quieter than the Reorder button beside it: Reorder is the action that
    // FIXES the order, this one opens a support chat, so it reads as secondary.
    // Outlined rather than filled for the same reason.
    complaintButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      marginTop: 9,
      paddingVertical: 9,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
    },
    complaintText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12.5,
      color: c.textSecondary,
    },

    /* ---------- Skeleton ---------- */
    placeholder: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      height: 92,
      borderRadius: 22,
      backgroundColor: c.skeleton,
      padding: 16,
    },
    placeholderBody: {
      flex: 1,
      gap: 9,
    },
    placeholderTail: {
      alignItems: "flex-end",
      gap: 9,
    },
    placeholderLine: {
      height: 12,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
      width: "70%",
    },
    placeholderLineShort: {
      height: 10,
      borderRadius: 5,
      backgroundColor: c.surfaceHover,
      width: "45%",
    },
    placeholderAmount: {
      height: 13,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
      width: 72,
    },
    placeholderBadge: {
      height: 18,
      borderRadius: 9,
      backgroundColor: c.surfaceHover,
      width: 62,
    },
  });

// Typography for the summary tiles and settlement rows. The per-row VALUES are
// tinted at the call site (they carry semantic colour); labels are plain.
const styles = StyleSheet.create({
  summaryTile: {
    flex: 1,
    alignItems: "center",
  },
  summaryValue: {
    fontFamily: fonts.displayBold,
      fontSize: 22,
      marginTop: 4,
      // Tabular figures so three numbers of different digit counts sit on one
      // baseline grid rather than appearing to jitter.
      fontVariant: ["tabular-nums"],
    },
    // The "Orders" tile is the answer the strip exists to give, so it is set a
    // step larger and brighter than the two context figures beside it.
    summaryValueAccent: {
      fontSize: 26,
    },
    summaryLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 9.5,
      letterSpacing: 1.1,
      textTransform: "uppercase",
    },
    breakdownTotal: {
      flexDirection: "row",
      // `center` rather than `baseline`: the label is 11.5px caps and the value is
      // 19px, and baseline alignment across that size jump renders the smaller text
      // sitting visibly high. Centered reads as one row.
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      marginTop: 11,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      // `borderTopColor` is NOT set here. This sheet is module-level and cannot
      // read the palette, so any colour written here would be a fixed literal that
      // is wrong in one of the two schemes - the same trap that left
      // `breakdownLabel` and `breakdownValue` on RN's default black. It is
      // applied from the component, which has `c` in scope.
    },
    breakdownTotalLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 11.5,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      // Truncates so a long label can never push the value onto a second line. The
      // value is the figure the reader came for; the label is what should give way.
      flexShrink: 1,
    },
    breakdownTotalValue: {
      fontFamily: fonts.displayBold,
      fontSize: 19,
      fontVariant: ["tabular-nums"],
      // Never wraps and is never squeezed out by a long label.
      flexShrink: 0,
    },
    breakdownRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 6,
    },
    // The leader is decorative and must never be read as content, so it is hidden
    // from screen readers - `BreakdownRow`'s label and value already convey the
    // whole row.
    leader: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 11,
      letterSpacing: 1.6,
      opacity: 0.5,
      textAlign: "center",
    },
    breakdownLabel: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      maxWidth: "52%",
    },
    breakdownValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 12.5,
      fontVariant: ["tabular-nums"],
    },
    breakdownValueEmphasis: {
      fontFamily: fonts.bodyBold,
      fontSize: 13.5,
    },
  });
