import React, { useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  ActivityIndicator,
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
import {
  updateSubAgentOrderStatus,
  SUPER_AGENT_WRITABLE_STATUSES,
} from "../lib/superAgentRoster";
import {
  fetchHistoryOrderPage,
  HISTORY_PAGE_SIZE,
} from "../services/historyPrefetch";

const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

// HOW MUCH HISTORY IS FETCHED AT A TIME.
//
// This screen used to load the ENTIRE history in one go - four separate
// unbounded `.select("*")` queries, merged and rendered inside a `ScrollView`.
//
// Two separate costs, both of which made the app slow:
//
//   1. THE QUERY. An unbounded select is clamped by PostgREST's `max-rows`
//      (1000 by default) SILENTLY, so a large history was both slow AND
//      truncated, with no indication anything was missing.
//   2. THE RENDER. A `ScrollView` renders every row it is given. A thousand
//      transaction cards - each with a status spine, a breakdown panel and
//      several nested `Text` nodes - is a thousand views mounted at once.
//
// The fix is the same shape as `OrderManagementScreen` in the admin app:
// fetch a page at a time, and load the next page when the user reaches the
// bottom. The list is also moved onto a `FlatList`, which unmounts rows that
// have scrolled away instead of keeping them all alive.
//
// FIVE ROWS PER SOURCE PAGE.
//
// Smaller pages reduce the initial payload and keep provider status checks
// scoped to fewer orders. Older rows are fetched as the user scrolls.
const PAGE_SIZE = HISTORY_PAGE_SIZE;

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
 * The sub-agent business names for a super agent, CACHED.
 *
 * A super agent's roster is the same on every page of their history - it
 * does not change because the user scrolled. So the edge call that fetches
 * it is made ONCE and the result reused for every subsequent page.
 *
 * Without this, scrolling through ten pages of history made ten identical
 * edge calls, each of which returned the whole roster.
 *
 * A failed fetch is NOT cached, so a transient failure does not leave the
 * screen permanently showing blank names - the next page tries again.
 */
const subAgentNameCache = new Map();

const getSubAgentBusinessNames = async (superAgentId) => {
  if (!superAgentId) return new Map();
  if (subAgentNameCache.has(superAgentId)) {
    return subAgentNameCache.get(superAgentId);
  }

  try {
    const subAgentFunctionName = getEdgeFunctionName(
      "super-agent-user-management",
    );
    let subAgentResult = await supabase.functions.invoke(
      subAgentFunctionName,
      { body: { action: "listUsers", superAgentId } },
    );
    if (
      subAgentResult.error &&
      subAgentFunctionName !== "super-agent-user-management"
    ) {
      subAgentResult = await supabase.functions.invoke(
        "super-agent-user-management",
        { body: { action: "listUsers", superAgentId } },
      );
    }
    if (subAgentResult.error) {
      console.error(
        "Error fetching sub-agent names:",
        subAgentResult.error,
      );
      return new Map();
    }

    const names = new Map(
      (subAgentResult.data?.users || []).map((subAgent) => [
        subAgent.id,
        subAgent.user_metadata?.business_name || "",
      ]),
    );
    subAgentNameCache.set(superAgentId, names);
    return names;
  } catch (error) {
    console.error("Error fetching sub-agent names:", error);
    return new Map();
  }
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
 *
 * ONE BATCHED CALL FOR THE WHOLE PAGE
 * -----------------------------------
 * This used to invoke the edge function ONCE PER ORDER. Each invocation
 * authenticated the caller, read the profile, called the provider and then
 * ran three database queries - roughly six round trips per order, all of
 * which had to finish before the list could render. Ten orders was sixty
 * round trips, and on a slow connection the screen was unusable.
 *
 * The edge function now accepts an ARRAY of provider order ids and does the
 * whole page in one invocation, with the provider calls concurrent and the
 * database work batched. Same work, a fraction of the round trips.
 *
 * ORDERS THAT ALREADY SETTLED ARE NOT ASKED ABOUT AT ALL
 * ------------------------------------------------------
 * An order whose provider status is already `COMPLETED` (or `DELIVERED`)
 * cannot change. Asking the provider about it again is a guaranteed waste of
 * a round trip, and on a long history those are the MAJORITY of the rows.
 * Only orders that could still move are sent to the provider.
 *
 * This is the single biggest win on a long history, and it is why a page of
 * five old orders costs almost nothing while a page of five fresh ones costs
 * one batched call.
 */
const refreshProviderStatuses = async (orders, table) => {
  const rows = orders || [];
  if (rows.length === 0) return [];

  // WHICH ORDERS COULD STILL CHANGE.
  //
  // A settled provider status is final. An order with no provider id was
  // never dispatched, so there is nothing to ask about. An order whose
  // provider status is still `processing` is exactly the one worth asking.
  const settled = new Set(["completed", "delivered"]);

  // The rows we do NOT ask about are returned untouched, so the caller still
  // gets one row per order.
  const needsRefresh = rows.filter((order) => {
    if (!order.jehuca_order_id) return false;
    const providerStatus = String(order.jehuca_order_status || "")
      .trim()
      .toLowerCase();
    if (settled.has(providerStatus)) return false;
    return true;
  });

  if (needsRefresh.length === 0) return rows;

  // THE PROVIDER IDS, DEDUPED.
  //
  // The same provider id can appear on more than one row (a wallet order
  // mirrored onto `orders` and `agent_orders`, for instance). Asking the
  // provider about it twice is pure waste.
  const providerGroups = new Map();
  needsRefresh.forEach((order) => {
    const providerName = String(order.provider_name || "jehuca").toLowerCase();
    const orderId = String(order.jehuca_order_id || "").trim();
    if (!orderId) return;
    const ids = providerGroups.get(providerName) || new Set();
    ids.add(orderId);
    providerGroups.set(providerName, ids);
  });

  if (providerGroups.size === 0) return rows;

  let results = [];
  try {
    const functionName = getEdgeFunctionName("check-order-status");
    for (const [providerName, idSet] of providerGroups) {
      const body = {
        orderIds: Array.from(idSet),
        provider_name: providerName,
      };
      let response = await supabase.functions.invoke(functionName, { body });
      if (response.error && functionName !== "check-order-status") {
        response = await supabase.functions.invoke("check-order-status", {
          body,
        });
      }
      if (response.error) {
        return await refreshProviderStatusesOneByOne(needsRefresh, table);
      }
      results.push(
        ...(response.data?.results || []).map((result) => ({
          ...result,
          providerName,
        })),
      );
    }
  } catch (error) {
    console.warn("Unable to refresh Jehuca status:", error);
    return rows;
  }

  // The status each provider order id resolved to.
  const statusById = new Map();
  (results || []).forEach((result) => {
    if (!result?.orderId) return;
    if (result.success === false) {
      // A 404 is TERMINAL, not transient: the order has fallen out of the
      // provider's retention window and no retry can recover it. Warn once
      // per order id instead of once per order per refresh. Everything else
      // (balance errors, network blips) stays a per-refresh warning because
      // those genuinely are worth retrying.
      if (result.notFound || result.providerStatusCode === 404) {
        warnProviderOrderMissingOnce(result.orderId);
      } else {
        console.warn(
          "Jehucal status request failed:",
          result.error,
          result.providerStatusCode,
        );
      }
      return;
    }
    const status =
      result.orderStatus ||
      result.providerOrderStatus ||
      (typeof result.status === "string" ? result.status : null);
    if (isRealStatus(status)) {
      statusById.set(
        `${result.providerName || "jehuca"}::${String(result.orderId)}`,
        status,
      );
    }
  });

  // THE WRITE-BACK FALLBACK.
  //
  // `synced === true` means the deployed function already wrote the status
  // server-side, to every table carrying this provider id. Writing again from
  // here is redundant - and keeping two writers is how the field drifted from
  // the provider in the first place. `synced` undefined means the response
  // came from the OLD build, which has no server-side sync, so the write-back
  // below is the only persistence path there.
  const writeBack = async (order) => {
    const providerName = String(order.provider_name || "jehuca").toLowerCase();
    const statusKey = `${providerName}::${String(order.jehuca_order_id)}`;
    const providerStatus = statusById.get(statusKey);
    if (!providerStatus) return order;

    const result = (results || []).find(
      (r) =>
        String(r?.providerName || "jehuca").toLowerCase() === providerName &&
        String(r?.orderId) === String(order.jehuca_order_id),
    );

    if (result?.synced !== true && providerStatus !== order.jehuca_order_status) {
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
  };

  const refreshed = await Promise.all(needsRefresh.map(writeBack));

  // PUT THE ROWS BACK IN THEIR ORIGINAL ORDER.
  //
  // `refreshed` only covers the orders we asked the provider about, and
  // `untouched` holds the settled ones. Returning `refreshed` alone would
  // silently DROP every settled order from the list - which, on a long
  // history, is most of the rows. The caller expects one row back per row
  // in, in the order it gave them.
  const refreshedById = new Map(
    refreshed.map((order) => [order.id, order]),
  );
  return rows.map((order) => refreshedById.get(order.id) || order);
};

/**
 * The per-order fallback, used only when the deployed edge function is too
 * old to understand a batch.
 *
 * Slow - one invocation per order - but correct. It exists so that a stale
 * deployment degrades to "slow" rather than to "broken".
 */
const refreshProviderStatusesOneByOne = async (orders, table) => {
  const results = await Promise.all(
    (orders || []).map(async (order) => {
      if (!order.jehuca_order_id) return order;

      try {
        const { data, error } = await supabase.functions.invoke(
          getEdgeFunctionName("check-order-status"),
          {
            body: {
              orderId: order.jehuca_order_id,
              provider_name: order.provider_name || "jehuca",
            },
          },
        );
        if (error) {
          if (
            getEdgeFunctionName("check-order-status") !== "check-order-status"
          ) {
            const fallback = await supabase.functions.invoke(
              "check-order-status",
              {
                body: {
                  orderId: order.jehuca_order_id,
                  provider_name: order.provider_name || "jehuca",
                },
              },
            );
            if (!fallback.error) {
              const fallbackStatus =
                fallback.data?.orderStatus ||
                fallback.data?.providerOrderStatus ||
                (typeof fallback.data?.status === "string"
                  ? fallback.data.status
                  : null);
              if (!isRealStatus(fallbackStatus)) return order;
              return { ...order, jehuca_order_status: fallbackStatus };
            }
          }
          return order;
        }
        if (data?.success === false) {
          if (data?.notFound || data?.providerStatusCode === 404) {
            warnProviderOrderMissingOnce(order.jehuca_order_id);
          } else {
            console.warn(
              "Jehucal status request failed:",
              data.error,
              data.providerStatusCode,
            );
          }
          return order;
        }

        const providerStatus =
          data?.orderStatus ||
          data?.providerOrderStatus ||
          data?.payload?.packages?.[0]?.status ||
          data?.payload?.status ||
          (typeof data?.status === "string" ? data.status : null);

        if (!isRealStatus(providerStatus)) return order;

        if (data?.synced === true) {
          return { ...order, jehuca_order_status: providerStatus };
        }

        if (providerStatus !== order.jehuca_order_status) {
          const { error: writeError } = await supabase
            .from(table)
            .update({ jehuca_order_status: providerStatus })
            .eq("id", order.id);
          if (writeError) {
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
  // Whether there is more history below the last loaded page. False once every
  // source has run out of rows, which is what stops the "load more" footer
  // from appearing on a screen that has nothing more to show.
  const [hasMore, setHasMore] = useState(true);
  // How many pages have been loaded. Used to work out which page to ask for
  // next, and to render "Showing N transactions" - a truthful statement about
  // what is on screen, rather than a count of the entire history which would
  // require reading the whole thing to know.
  const [loadedPages, setLoadedPages] = useState(0);
  // True while a further page is being fetched. Prevents the footer spinner
  // from firing several overlapping requests when the user keeps scrolling.
  const [loadingMore, setLoadingMore] = useState(false);
  const [isAgent, setIsAgent] = useState(false);
  const [isSuperAgentUser, setIsSuperAgentUser] = useState(false);
  const [reorderingId, setReorderingId] = useState(null);
  // The order whose status picker is expanded, or null. An id rather than a
  // boolean so two rows cannot be open at once - with a boolean, tapping a
  // second row would silently move the picker rather than opening a new one.
  const [statusEditingId, setStatusEditingId] = useState(null);
  const [statusSaving, setStatusSaving] = useState(false);
  // The order the super agent is currently disputing. Null when the sheet is
  // closed. One object rather than a boolean so the sheet is always given the
  // row it belongs to - reopening for a different order must not show the
  // previous one's details.
  const [complaintOrder, setComplaintOrder] = useState(null);
  const { showError, showSuccess } = useNotification();
  const {
    isSuperAgent: isSuperAgentProfile,
    isSubAgent: isAgentProfile,
    profile,
    loading: profileLoading,
  } = useProfile();

  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", () => {
      checkAgentStatus(true);
    });

    // The mount-time focus event can fire before the listener is attached, so
    // load once here only when this screen is already focused. This avoids the
    // previous mount request plus focus request racing each other.
    if (navigation.isFocused()) checkAgentStatus();

    return unsubscribe;
  }, [
    navigation,
    profile?.id,
    profileLoading,
    isAgentProfile,
    isSuperAgentProfile,
  ]);

  // Real-time updates for orders
  useEffect(() => {
    let historyChannel = null;
    let cancelled = false;
    const userId = profile?.id;
    if (!userId || profileLoading) return undefined;

    const setupRealtimeSubscriptions = async () => {
      try {
        if (cancelled) return;

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
            filter: `user_id=eq.${userId}`,
          },
          () => checkAgentStatus(true),
        );

        channel.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "agent_orders",
            filter: `agent_id=eq.${userId}`,
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
              filter: `super_agent_id=eq.${userId}`,
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
                      filter: `super_agent_id=eq.${userId}`,
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
  }, [
    profile?.id,
    profileLoading,
    isAgentProfile,
    isSuperAgentProfile,
  ]);

  const checkAgentStatus = async (isRefresh = false) => {
    if (profileLoading || !profile?.id) return;

    // Identity and roles are already resolved by ProfileContext. Avoid a
    // second auth.getUser network request before using the prefetched page.
    setIsSuperAgentUser(isSuperAgentProfile);
    setIsAgent(isAgentProfile);
    fetchTransactions(isAgentProfile, isRefresh);
  };

  const fetchTransactions = async (
    agentStatus = isAgent,
    isRefresh = false,
    page = 0,
  ) => {
    try {
      if (!isRefresh) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      const user = profile?.id ? { id: profile.id } : null;
      if (user) {
        let allTransactions = [];
        const pendingStatusRefreshes = [];
        let subAgentBusinessNamesRequest = null;
        let walletOrdersForSettlement = [];
        const subAgentIdsByOrderKey = new Map();

        // THE PAGE WINDOW.
        //
        // Each source is read with the SAME server-side range. The sources are
        // merged and sorted below; paging remains independent per source.
        //
        // The range is applied per source rather than after the merge, because
        // the merge happens in memory across four different tables - there is
        // no single query to page. The consequence is that a page is not
        // guaranteed to hold exactly `PAGE_SIZE` rows, which is why
        // `hasMore` is decided per source rather than from the merged length.
        // Home prefetches this page while the user is there; this shares its
        // in-flight request or warm result. Later pages use the same query path
        // without entering the first-page cache.
        const {
          regularOrders: regularOrdersRequest,
          agentOrders: agentOrdersRequest,
          assignedOrders: assignedOrdersRequest,
          walletOrders: walletOrdersRequest,
        } = await fetchHistoryOrderPage({
          userId: user.id,
          isAgent: agentStatus,
          isSuperAgent: isSuperAgentProfile,
          page,
        });

        // A source is "exhausted" when it returned fewer rows than the window
        // asked for. Tracked per source so the screen knows when EVERY branch
        // is exhausted, and only then stops offering to load more.
        let anySourceHasMore = false;

        const markExhausted = (rowCount) => {
          if (rowCount >= PAGE_SIZE) anySourceHasMore = true;
        };

        // Fetch regular orders
        const { data: regularOrders, error: regularError } =
          await regularOrdersRequest;

        if (regularError) {
          console.error("Error fetching regular orders:", regularError);
        } else {
          markExhausted((regularOrders || []).length);
          // Keep the first render independent from provider latency. The
          // saved order state is shown immediately; any provider status change
          // is applied to the visible rows in the background.
          pendingStatusRefreshes.push({
            orders: regularOrders,
            table: "orders",
            orderType: "regular",
          });
          const normalizedRegularOrders = regularOrders.map(
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
          const { data: agentOrders, error: agentError } =
            await agentOrdersRequest;

          if (agentError) {
            console.error("Error fetching agent orders:", agentError);
          } else {
            markExhausted((agentOrders || []).length);
            pendingStatusRefreshes.push({
              orders: agentOrders,
              table: "agent_orders",
              orderType: "agent",
            });
            const normalizedAgentOrders = agentOrders.map((order) => ({
              ...order,
              orderType: "agent",
              displayName: order.recipient_name,
              displayPhone: order.recipient_phone,
            }));
            allTransactions = [...allTransactions, ...normalizedAgentOrders];
          }
        }

        if (isSuperAgentProfile) {
          // Declared OUTSIDE the `else` below, and mutated rather than shadowed.
                    //
                    // The wallet-order branch that follows needs this same map, and it must
                    // run even when `assignedError` fired - a denied `agent_orders` read
                    // must not blank the wallet orders or strip their sub-agent names.
                    // Declaring it inside the `else` would put it in that block's scope,
                    // where the branch below cannot see it: a `ReferenceError` on every
                    // super agent whose Paystack read succeeded.
                    let subAgentBusinessNames = new Map();

                    const { data: assignedOrders, error: assignedError } =
                      await assignedOrdersRequest;

          if (assignedError) {
            console.error("Error fetching sub-agent orders:", assignedError);
          } else {
            markExhausted((assignedOrders || []).length);
            pendingStatusRefreshes.push({
              orders: assignedOrders,
              table: "agent_orders",
              orderType: "agent",
            });
            // THE SUB-AGENT NAMES.
            //
            // These come from an edge function and are the SAME on every page
            // - the roster does not change because the user scrolled. So they
            // are fetched ONCE and cached, rather than re-fetched for every
            // page the user loads. On a history the user scrolls through
            // several pages, that was several identical edge calls.
            subAgentBusinessNamesRequest =
              getSubAgentBusinessNames(user.id);
            const assignedTransactions = assignedOrders.map(
              (order) => ({
                ...order,
                orderType: "agent",
                isSubAgentTransaction: true,
                subAgentBusinessName: "",
                displayName: order.recipient_name,
                displayPhone: order.recipient_phone,
              }),
            );
            assignedOrders.forEach((order) => {
              subAgentIdsByOrderKey.set(`agent-${order.id}`, order.agent_id);
            });
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
                      // A denied read must not blank the orders already loaded.
                      try {
                        const { data: walletOrders, error: walletOrdersError } =
                          await walletOrdersRequest;

                        if (walletOrdersError) {
                          console.error(
                            "Error fetching sub-agent wallet orders:",
                            walletOrdersError,
                          );
                        } else {
                          markExhausted((walletOrders || []).length);
                          walletOrdersForSettlement = walletOrders || [];
                          pendingStatusRefreshes.push({
                            orders: walletOrders,
                            table: "orders",
                            orderType: "regular",
                          });

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
                          const walletTransactions = walletOrders.map((order) => {
                            subAgentIdsByOrderKey.set(
                              `regular-${order.id}`,
                              order.user_id,
                            );
                            return {
                              ...order,
                              orderType: "regular",
                              isSubAgentTransaction: true,
                              subAgentBusinessName: "",
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
                                                            gross_amount: order.amount ?? null,
                                                            // What the super agent's wallet was actually drawn down by:
                                                            // the admin-set base price.
                                                            //
                                                            // `null` when unknown, NEVER defaulted to 0. A zero here
                                                            // would flow into the derivation below as "the sale price
                                                            // IS the margin", inventing a profit figure that was never
                                                            // recorded - and `formatGhc` would render it as a
                                                            // confident number.
                                                            base_amount: null,
                                                            // Always 0 on a wallet order - the money came from a mirrored
                                                            // balance charged once at top-up, so there is no per-order
                                                            // provider fee. 0 is a REAL value here, not a stand-in for
                                                            // missing, so it is preserved rather than nulled.
                                                            transaction_fee: 0,
                                                            // What the platform took: the sale price less the base price.
                                                            main_account_amount: null,
                                                            settlement_status: null,
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
                                                            super_agent_share: null,
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

        // APPEND, NOT REPLACE.
        //
        // Page 0 replaces the list - it is the whole list so far. Later pages
        // are ADDED to it, which is the entire point of the batching: the
        // user scrolls to the bottom and the next page arrives underneath
        // what they are already looking at.
        //
        // A page is never allowed to REPLACE an earlier one, because a
        // transient read failure would then silently truncate the history
        // back to whatever the last good page held. `page === 0` is the only
        // case that resets.
        if (page === 0) {
          setTransactions(allTransactions);
        } else {
          setTransactions((previous) => {
            const merged = [...previous, ...allTransactions];
            // A row can appear twice: the same order can be visible through
            // two branches (a super agent's own wallet order is in `orders`
            // under `user_id`, and also under `super_agent_id` when they are
            // their own agent). Deduplicate on the row's identity, keeping the
            // FIRST occurrence - which is the one from the earlier branch.
            const seen = new Set();
            const unique = [];
            merged.forEach((transaction) => {
              const key = `${transaction.source || transaction.orderType || "order"}-${transaction.id}`;
              if (seen.has(key)) return;
              seen.add(key);
              unique.push(transaction);
            });
            return unique.sort(
              (a, b) => new Date(b.created_at) - new Date(a.created_at),
            );
          });
        }

        if (subAgentBusinessNamesRequest) {
          subAgentBusinessNamesRequest
            .then((names) => {
              setTransactions((previous) =>
                previous.map((transaction) => {
                  if (!transaction.isSubAgentTransaction) return transaction;
                  const source = transaction.orderType || "regular";
                  const subAgentId = subAgentIdsByOrderKey.get(
                    `${source}-${transaction.id}`,
                  );
                  if (!subAgentId) return transaction;
                  return {
                    ...transaction,
                    subAgentBusinessName: names.get(subAgentId) || "",
                  };
                }),
              );
            })
            .catch((error) => {
              console.error("Error refreshing sub-agent names:", error);
            });
        }

        if (walletOrdersForSettlement.length > 0) {
          const walletOrderIds = walletOrdersForSettlement.map(
            (order) => order.id,
          );
          supabase
            .from("payment_transactions")
            .select(
              "order_id, order_type, gross_amount, base_amount, transaction_fee, main_account_amount, super_agent_amount, settlement_status",
            )
            .eq("order_type", "regular")
            .in("order_id", walletOrderIds)
            .then(({ data, error }) => {
              if (error) {
                console.error(
                  "Error fetching wallet order settlements:",
                  error,
                );
                return;
              }

              const paymentsByOrderId = new Map(
                (data || []).map((payment) => [payment.order_id, payment]),
              );
              const walletOrderIdSet = new Set(walletOrderIds);
              setTransactions((previous) =>
                previous.map((transaction) => {
                  if (
                    transaction.orderType !== "regular" ||
                    !transaction.isSubAgentTransaction ||
                    !walletOrderIdSet.has(transaction.id)
                  ) {
                    return transaction;
                  }
                  const payment = paymentsByOrderId.get(transaction.id);
                  if (!payment) return transaction;
                  const gross =
                    payment.gross_amount ?? transaction.gross_amount ?? null;
                  const base = payment.base_amount ?? null;
                  const grossNumber = Number(gross);
                  const baseNumber = Number(base);

                  return {
                    ...transaction,
                    gross_amount: gross,
                    base_amount: base,
                    transaction_fee: payment.transaction_fee ?? 0,
                    main_account_amount:
                      payment.main_account_amount ?? null,
                    settlement_status: payment.settlement_status ?? null,
                    super_agent_share:
                      gross !== null &&
                      gross !== undefined &&
                      base !== null &&
                      base !== undefined &&
                      Number.isFinite(grossNumber) &&
                      Number.isFinite(baseNumber)
                        ? Number((grossNumber - baseNumber).toFixed(2))
                        : null,
                  };
                }),
              );
            })
            .catch((error) => {
              console.error("Error fetching wallet order settlements:", error);
            });
        }

        // Provider lookups can be much slower than reading saved history.
        // Refresh them after the rows are scheduled for display, then patch
        // status only so paging, names and settlement details remain intact.
        const statusRefreshesBySource = new Map();
        pendingStatusRefreshes.forEach(({ orders, table, orderType }) => {
          const key = `${table}:${orderType}`;
          const rows = statusRefreshesBySource.get(key) || new Map();
          (orders || []).forEach((order) => rows.set(order.id, order));
          statusRefreshesBySource.set(key, rows);
        });
        Promise.all(
          [...statusRefreshesBySource.entries()].map(
            async ([key, rowsById]) => {
              const [table, orderType] = key.split(":");
              const refreshedOrders = await refreshProviderStatuses(
                [...rowsById.values()],
                table,
              );
              const refreshedById = new Map(
                refreshedOrders.map((order) => [order.id, order]),
              );
              setTransactions((previous) =>
                previous.map((transaction) => {
                  if (transaction.orderType !== orderType) return transaction;
                  const refreshed = refreshedById.get(transaction.id);
                  if (!refreshed) return transaction;
                  return {
                    ...transaction,
                    jehuca_order_status: refreshed.jehuca_order_status,
                  };
                }),
              );
            },
          ),
        ).catch((error) => {
          console.error("Error refreshing transaction statuses:", error);
        });

        // Whether the user can still scroll for more. True while ANY source
        // had a full page; false once every source has run dry.
        setHasMore(anySourceHasMore);
        setLoadedPages(page + 1);
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  /**
     * Moves a sub-agent's order to a new lifecycle status.
     *
     * Two rules are enforced by the SERVER and are deliberately not re-implemented
     * here: ownership (the row's `super_agent_id` must be the caller) and the
     * exclusion of the money-moving statuses. `cancelled` and `refunded` are not in
     * `SUPER_AGENT_WRITABLE_STATUSES` because those route through
     * `cancel_admin_order`, which CREDITS the debited wallet - a super agent is a
     * commercial party to these orders, so allowing it would let them refund
     * themselves for data the recipient already received. Re-deriving either rule on
     * the client would be a second copy that drifts, and a client that "corrects"
     * the server is exactly how a restriction gets bypassed.
     *
     * RELOADS rather than patching local state: one call also settles
     * `settlement_status` on both `agent_orders` and `payment_transactions` - two
     * tables this list merges - and a local patch would leave them disagreeing on
     * screen.
     */
    const handleStatusChange = async (orderId, status) => {
      setStatusSaving(true);
      try {
        const result = await updateSubAgentOrderStatus(orderId, status);
        if (!result.ok) {
          showError("Update failed", result.message);
          return;
        }
        setStatusEditingId(null);
        const label =
          SUPER_AGENT_WRITABLE_STATUSES.find((o) => o.value === status)?.label ||
          status;
        showSuccess("Order updated", `Order marked as ${label}.`);
        await checkAgentStatus(true);
      } finally {
        setStatusSaving(false);
      }
    };

    const onRefresh = () => {
      // A refresh goes back to page 0. The pages already loaded are replaced,
      // not appended to, because a refresh is a statement that what is on
      // screen may have changed - keeping the old rows underneath would show
      // stale transactions next to fresh ones.
      setHasMore(true);
      setLoadedPages(0);
      checkAgentStatus(true);
    };

    // LOAD THE NEXT PAGE.
    //
    // Fired when the list reaches the bottom. Guarded on three things, all of
    // which have to be true for it to run:
    //
    //   hasMore      - some source still has rows beyond what is loaded.
    //   !loadingMore - a request is not already in flight. Without this the
    //                  user scrolling past the bottom fires a burst of
    //                  overlapping page requests, each of which appends the
    //                  SAME rows.
    //   !loading     - the first page is still loading.
    const loadMore = () => {
      if (!hasMore || loadingMore || loading) return;
      setLoadingMore(true);
      fetchTransactions(isAgent, true, loadedPages)
        .catch((error) => {
          console.error("Error loading more history:", error);
          showError(
            "Could not load more",
            "Something went wrong loading older transactions. Pull down to retry.",
          );
        })
        .finally(() => setLoadingMore(false));
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

  // NO COUNT SUMMARY.
  //
  // There used to be a `counts` memo feeding a header count and a three-tile
  // summary strip. It is gone, and deliberately so:
  //
  //   - A count of the WHOLE history cannot be known without reading the
  //     whole history. With the list now paged, the screen only knows what it
  //     has loaded, so any "total" would have been a claim about rows that
  //     were never fetched.
  //   - Getting it honestly would have cost a `count: "exact"` query on
  //     every one of the four tables, on every load - exactly the work the
  //     batching removed.
  //   - "Settled" and "In flight" were counts of the LOADED rows, so they
  //     would have reported "3 settled" on a screen holding 3 of 400
  //     settled transactions. A confidently wrong figure is worse than none.
  //
  // The footer reports the number of transactions CURRENTLY ON SCREEN, which
  // is honestly known: it is the length of the array in memory.

  return (
    <View style={s.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      {/* A `FlatList`, not a `ScrollView`.

          THE REASON FOR THE CHANGE
          ------------------------
          A `ScrollView` renders EVERY row it is handed. Every transaction
          card is a stack of nested views - a status spine, a header, a
          description, a status pair and, for sub-agent rows, a whole
          settlement breakdown panel. Rendering a few hundred of those at
          once is what made this screen slow, and it got slower with every
          order the user made.

          A `FlatList` mounts only the rows near the viewport and unmounts
          the rest. The screen's memory and render cost stay flat however
          long the history is, which is the whole point of paging the data
          as well.

          The header, the skeleton and the empty state become the list's
          header and empty components, so the scroll position, the pull to
          refresh and the "load more" trigger all belong to the same
          scrollable - the list itself. */}
      <FlatList
        data={transactions.filter(
          (transaction) =>
            transaction?.source !== "wallet_topup" &&
            transaction?.orderType !== "topup",
        )}
        keyExtractor={(transaction) =>
          `${transaction.source || transaction.orderType || "order"}-${transaction.id}`
        }
        renderItem={({ item: transaction }) => {
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
                                          // THE TWO STATUS COLUMNS, resolved independently.
                                          //
                                          // An order carries OUR internal state and the
                                          // PROVIDER's mirrored one. They are read
                                          // separately here, each guarded by
                                          // `isRealStatus` so a corrupt boolean string
                                          // ("true") can never become a status.
                                          //
                                          // `displayStatus` below is the RESOLVED status
                                          // (internal lifecycle preferred) and is what the card's
                                          // SPINE is coloured from. `DualStatus` resolves
                                          // the same way, so the spine and the pill can
                                          // never show different words.
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
                                          {/* THE STATUS.

                                              ONE status, and it is the RESOLVED one - our
                                              internal lifecycle value when it is real,
                                              provider otherwise. That is the right answer to "what
                                              state is this?", and it is the SAME value the
                                              card's status SPINE is coloured from, so the
                                              pill and the edge rule can never disagree.

                                              The provider's status used to be shown beside
                                              ours, under a "Provider" label. It is internal
                                              information: a customer cannot call Jehucal and
                                              cannot tell which of the two systems is right.
                                              Showing both made a settled order look
                                              undecided. The provider status is still fetched
                                              and is persisted separately - it is simply not
                                              narrated.

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

                                      {/* UPDATE STATUS.

                                          Gated on `isSubAgent` - a super agent's OWN orders are not
                                          theirs to relabel, and the server would refuse the write
                                          anyway.

                                          Available on BOTH sub-agent shapes. The wallet one was
                                          previously excluded here on the premise that the edge
                                          function only reads `agent_orders`, so the button was
                                          hidden rather than made to work. That hid the control from
                                          the majority of the business: a wallet-funded purchase is
                                          the primary sub-agent flow, not an edge case.
                                          `super-agent-order-status` now resolves both tables and
                                          writes back to whichever it read, so the control works on
                                          either.

                                          Reorder stays wallet-excluded, though - `reorder-held-agent-order`
                                          genuinely acts on `agent_orders` only, and that one is a
                                          server change rather than a client one.

                                          The picker renders the SERVER's vocabulary
                                          (`SUPER_AGENT_WRITABLE_STATUSES`), never a local list, so
                                          the two surfaces cannot offer different actions. */}
                                      {isSubAgent ? (
                                        statusEditingId === transaction.id ? (
                                          <View style={s.statusPicker}>
                                            {SUPER_AGENT_WRITABLE_STATUSES.map((option) => {
                                              const isCurrent =
                                                String(cardInternalStatus || "").toLowerCase() ===
                                                option.value;
                                              return (
                                                <TouchableOpacity
                                                  key={option.value}
                                                  style={[
                                                    s.statusOption,
                                                    isCurrent && s.statusOptionCurrent,
                                                  ]}
                                                  disabled={statusSaving}
                                                  onPress={() =>
                                                    handleStatusChange(transaction.id, option.value)
                                                  }
                                                  activeOpacity={0.85}
                                                  accessibilityRole="button"
                                                  accessibilityLabel={`Mark order as ${option.label}`}
                                                >
                                                  <Text
                                                    style={[
                                                      s.statusOptionText,
                                                      isCurrent && s.statusOptionTextCurrent,
                                                    ]}
                                                  >
                                                    {option.label}
                                                  </Text>
                                                </TouchableOpacity>
                                              );
                                            })}
                                          </View>
                                        ) : (
                                          <TouchableOpacity
                                            style={s.statusButton}
                                            onPress={() => setStatusEditingId(transaction.id)}
                                            activeOpacity={0.85}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Update status of order ${transaction.id}`}
                                          >
                                            <Ionicons
                                              name="create-outline"
                                              size={14}
                                              color={c.mint}
                                            />
                                            <Text style={s.statusButtonText}>Update status</Text>
                                          </TouchableOpacity>
                                        )
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
        }}
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
        ListHeaderComponent={
          <>
            <View style={s.header}>
              <TouchableOpacity
                style={s.backButton}
                onPress={handleBack}
                activeOpacity={0.7}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Go back"
              >
                <Ionicons
                  name="chevron-back"
                  size={20}
                  color={c.textPrimary}
                />
              </TouchableOpacity>
              <View style={s.headerTextWrap}>
                <Text style={s.headerEyebrow}>Statement</Text>
                <Text style={s.headerTitle}>Transaction History</Text>
              </View>
            </View>
            {/* NO COUNT TILES.

                There used to be a header count and a three-tile summary strip
                ("Settled" / "In flight" / "Orders") above the list.

                They were the slowest part of the screen and they cost the most
                of what they showed. A COUNT OF THE WHOLE HISTORY cannot be
                known without reading the whole history, so the number was
                either wrong (the list is now paged, so the screen only knows
                what it has loaded) or it required an extra `count: "exact"`
                query on every table - four of them - on every single load. On
                a large history that is exactly the work the batching removed.

                "Settled" and "In flight" had the same problem: they are counts
                of the loaded rows, so they would have reported "3 settled" on
                a screen holding 3 of 400 settled transactions - a
                confidently wrong figure, which is worse than no figure.

                The rows themselves carry their own status, so nothing was lost
                by removing the summary. The count of what is CURRENTLY ON
                SCREEN is shown in the footer instead, because that one is
                honestly known: it is the length of the array in memory, not a
                claim about rows that were never loaded. */}
            {loading ? (
              // A CENTRED SPINNER, NOT A SKELETON.
              //
              // The screen used to render four shimmering placeholder cards
              // while the first page loaded. Two problems with that:
              //
              //   1. THE SKELETON LIES. It shows the SHAPE of a transaction
              //      card, so the user sees four transactions that are not
              //      there, then watches them vanish and be replaced by
              //      different content. A spinner says "not yet" and shows
              //      nothing it has not got.
              //   2. IT COSTS A FRAME EVERY TICK. The pulse was driven by an
              //      `Animated` loop that re-rendered the whole list while
              //      the data was arriving - the exact opposite of what a
              //      loading state should be doing.
              //
              // A single centred `ActivityIndicator` says the same thing
              // more honestly and costs nothing to animate.
              <View style={s.loadingState}>
                <ActivityIndicator
                  size="large"
                  color={c.mint}
                  style={s.loadingSpinner}
                />
                <Text style={s.loadingText}>Loading your transactions…</Text>
              </View>
            ) : null}
          </>
        }
        ListEmptyComponent={
          loading ? null : (
            <EmptyState
              icon="receipt-outline"
              title="Nothing on the statement yet"
              message={
                isSuperAgentUser
                  ? "Orders your sub-agents place — whether they pay by card or from a wallet balance — land here, along with every settlement split."
                  : "Your purchases will appear here once you buy a data bundle."
              }
            />
          )
        }
        ListFooterComponent={
          transactions.length === 0 ? null : (
            <View style={s.footer}>
              {loadingMore ? (
                <ActivityIndicator
                  size="small"
                  color={c.mint}
                  style={styles.footerSpinner}
                />
              ) : hasMore ? (
                <TouchableOpacity
                  style={s.loadMoreButton}
                  onPress={loadMore}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Load older transactions"
                >
                  <Text style={s.loadMoreText}>Load older transactions</Text>
                  <Ionicons
                    name="chevron-down"
                    size={15}
                    color={c.mint}
                  />
                </TouchableOpacity>
              ) : (
                <Text style={s.footerText}>
                  Showing all {transactions.length} transaction
                  {transactions.length === 1 ? "" : "s"}
                </Text>
              )}
            </View>
          )
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        // THE GAP BETWEEN TRANSACTION CARDS.
        //
        // This used to be `gap: 12` on a wrapping `View` around the whole
        // list. That stopped working when the list became a `FlatList`:
        // `gap` on a `ScrollView` child spaced the CARDS, but a `FlatList`
        // renders each row as a direct child of the list, and the wrapper
        // only ever wrapped the SKELETON. So the cards ended up flush
        // against each other with no space at all - which on a list of
        // rounded cards with drop shadows reads as one broken block rather
        // than as a list of separate items.
        //
        // `ItemSeparatorComponent` is the right tool rather than padding
        // every row: a separator is ONE view for the whole list, whereas
        // padding each card would add that padding to the first and last
        // row as well, and would put the space INSIDE the card's shadow
        // instead of between the shadows.
        ItemSeparatorComponent={() => <View style={s.listSeparator} />}
        // The window of rows kept mounted either side of the viewport. The
        // default of 10 is tight for cards this tall - scrolling back up
        // would re-mount them and the user would see a flash. 6 keeps a
        // comfortable buffer without holding the whole list in memory.
        windowSize={6}
        // Render the first five rows immediately; further rows are loaded
        // as the user scrolls.
        initialNumToRender={PAGE_SIZE}
        maxToRenderPerBatch={PAGE_SIZE}
        removeClippedSubviews
      />

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
 * `resolveOrderStatus` picks the internal lifecycle state whenever it is real,
 * so a card can only ever show one status:
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
 * THE PROVIDER COLUMN IS NOT SHOWN
 * --------------------------------
 * The provider's mirrored status used to be shown beside ours, under a
 * "Provider" label. It is hidden now.
 *
 * The reason is that it is INTERNAL INFORMATION. "Ours" and "Provider" are
 * two views of one order from two different systems, and a customer looking
 * at their transaction list has no way to act on the difference - they cannot
 * call Jehucal, and they certainly cannot tell which of the two is "right".
 * Showing them side by side made a settled order look undecided.
 *
 * So the card shows ONE status: the RESOLVED one, which is our internal
 * lifecycle value when it is real and the provider value otherwise. That is
 * the same value the card's status SPINE is coloured from, so the pill and the edge rule can never
 * disagree - which was the whole reason the two columns were ever shown side
 * by side.
 *
 * The provider status is still fetched and persisted separately. Hiding it is
 * a display decision, not a data decision.
 */
function DualStatus({
  s,
  internalStatus,
  providerStatus,
  toneOf,
  labelOf,
  // Whether the status shares a row with something else that it must not crowd
  // out. True in the card foot (the chevron lives beside it), false in the
  // settlement panel (it owns the line).
  fill = false,
}) {
  // THE RESOLVED STATUS: our internal lifecycle state when real, provider otherwise.
  //
  // This is exactly `resolveOrderStatus`'s rule, applied here so the pill and
  // the card's spine colour cannot disagree. The spine is coloured from
  // `resolveOrderStatus(transaction)`, and if the pill resolved the status a
  // different way the two could show different words.
  const resolved = internalStatus || providerStatus;

  return (
    <View style={[s.statusPair, fill ? { flex: 1 } : null]}>
      {resolved ? (
        <View style={[s.pill, { backgroundColor: toneOf(resolved).bg }]}>
          <Text style={[s.pillText, { color: toneOf(resolved).color }]}>
            {labelOf(resolved)}
          </Text>
        </View>
      ) : (
        // An em dash rather than a pill: an unreported status is absent data,
        // and giving it a chip would make it weigh the same as a real one.
        <Text style={s.statusPairNone}>—</Text>
      )}
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

    /* ---------- Footer: paging ---------- */
    // The footer carries the paging control and the honest "showing N"
    // statement. It sits BELOW the last row rather than being pinned, so it
    // scrolls with the content and never covers a transaction.
    footer: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 22,
      gap: 10,
    },
    loadMoreButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.hairline,
      backgroundColor: c.surface,
    },
    loadMoreText: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.mint,
    },
    footerText: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
    },

    /* ---------- Cards ---------- */
    list: {
      gap: 12,
    },
    // THE GAP BETWEEN CARDS.
    //
    // A plain height, not a margin on the card. A margin would have to be
    // applied to every row, and the first and last rows would then carry a
    // margin too - pushing the first card away from the header and leaving
    // dead space under the last one.
    //
    // 12 matches the `gap: 12` the list used to have, so the spacing is
    // unchanged from before the `FlatList` conversion - it was simply lost
    // in that conversion and is now restored where it actually applies.
    listSeparator: {
      height: 12,
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
        // The status row.
        //
        // It holds ONE status now. It used to hold two - "Ours" and
        // "Provider" - side by side, which is why the name is still a pair.
        // The provider column was removed; see the note on `DualStatus`.
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
        // Outlined, not filled: on a HELD order the Reorder button is the primary
        // action and sits directly above it. Two filled mint buttons in one card
        // would give the pair equal weight and neither would read as primary.
        statusButton: {
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
        statusButtonText: {
          fontFamily: fonts.bodySemi,
          fontSize: 12.5,
          color: c.mint,
        },
        statusPicker: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
          marginTop: 9,
        },
        statusOption: {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: c.hairlineStrong,
        },
        // The status already applied. Filled rather than outlined so "what is it
        // now?" is answerable at a glance without reading all four labels.
        statusOptionCurrent: {
          backgroundColor: c.surfaceHover,
          borderColor: c.mintDim,
        },
        statusOptionText: {
          fontFamily: fonts.bodySemi,
          fontSize: 12,
          color: c.textSecondary,
        },
        statusOptionTextCurrent: {
          color: c.mint,
        },

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

    /* ---------- Loading ---------- */
    // The centred loading state.
    //
    // Centred VERTICALLY as well as horizontally, so it sits in the middle of
    // the screen rather than at the top under the header - a spinner in the
    // top-left corner reads as "something is wrong with the header", while a
    // centred one reads as "the screen is loading".
    loadingState: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 72,
      gap: 14,
    },
    loadingSpinner: {
      // `ActivityIndicator` on Android draws its own bounds; this nudges it
      // off the text baseline so the two are not fighting for the same line.
      marginBottom: 2,
    },
    loadingText: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textMuted,
    },
  });

// Typography for the summary tiles and settlement rows. The per-row VALUES are
// tinted at the call site (they carry semantic colour); labels are plain.
const styles = StyleSheet.create({
  // The paging spinner in the footer. Module-level because it carries no
  // palette-dependent colour - the `ActivityIndicator` takes its colour from
  // the `color` prop, which is theme-aware and passed in at the call site.
  footerSpinner: {
    marginVertical: 4,
  },
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
