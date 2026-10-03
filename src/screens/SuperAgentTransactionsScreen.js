import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { useProfile } from "../contexts/ProfileContext";
import {
  isHeldWindowElapsed,
  isReorderableHeldOrder,
  reorderHeldOrder,
} from "../lib/heldOrderReorder";
import {
  fetchSubAgentBalances,
  fetchSubAgentOrders,
  fetchSubAgentPayments,
  fetchWalletLedger,
  SUPER_AGENT_WRITABLE_STATUSES,
  updateSubAgentOrderStatus,
} from "../lib/superAgentRoster";
import colors from "../components/theme";
import { ThemedScreen } from "../components/ui";

/**
 * What the screen is showing.
 *
 * "mine"  - the super agent's own money and their own purchases. Unchanged.
 * "roster" - everything their sub-agents did: orders, payment records,
 *            wallet actions and current balances.
 *
 * The split exists because the two are genuinely different questions and the
 * old screen answered neither. It listed the super agent's own top-ups and
 * payments, then added ONLY their sub-agents' HELD orders. Held means "our
 * wallet debit failed, retry this" - it is a repair queue, not a business
 * view. So a super agent whose sub-agent bought forty packages successfully
 * saw an almost-empty ledger, because none of those forty were held.
 */
const SCOPES = [
  { key: "mine", label: "My activity" },
  { key: "roster", label: "My sub-agents" },
];

const STATUS_LABELS = SUPER_AGENT_WRITABLE_STATUSES.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {});

/**
 * Human label for a wallet ledger `reason`.
 *
 * Mirrors the admin Wallet screen's presentation so the same movement reads
 * the same way to both parties.
 */
const LEDGER_REASON_LABELS = {
  wallet_topup: "Wallet top-up",
  admin_wallet_topup: "Admin top-up",
  admin_wallet_debit: "Admin debit",
  sub_agent_order: "Sub-agent order",
  sub_agent_package_purchase: "Sub-agent purchase",
  super_agent_package_purchase: "Wallet purchase",
  sub_agent_mirror_rollback: "Mirror rollback",
  order_refund: "Order refund",
  order_release: "Order release",
  held_order_release: "Held order release",
};

const ledgerReasonLabel = (reason) => {
  const key = String(reason || "")
    .trim()
    .toLowerCase();
  if (LEDGER_REASON_LABELS[key]) return LEDGER_REASON_LABELS[key];
  return key
    ? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
    : "Wallet movement";
};

export default function SuperAgentTransactionsScreen({ navigation }) {
  const { showError, showSuccess } = useNotification();
  const { isSuperAgent } = useProfile();
  const [loading, setLoading] = useState(true);
    const [scope, setScope] = useState("mine");
    // Two lists, chosen by the scope toggle below. See the note where they are
    // populated for why they are not one list plus a render-time filter.
    const [ownTransactions, setOwnTransactions] = useState([]);
    const [rosterTransactions, setRosterTransactions] = useState([]);
    const transactions =
      scope === "roster" ? rosterTransactions : ownTransactions;
    // Id of the held order being retried, or null. One id rather than a boolean so
    // a second row cannot be tapped mid-flight.
    const [reorderingId, setReorderingId] = useState(null);

  // Id of the order whose status picker is expanded, or null. One id rather
  // than a boolean so a second row cannot be tapped mid-flight.
  const [statusEditingId, setStatusEditingId] = useState(null);
  const [statusSaving, setStatusSaving] = useState(false);

    // "My sub-agents" balances. Previously unreachable: there was no screen a
    // super agent could open to answer "how much has each of my agents got left
    // to spend", because the mirror is keyed on the SUB-AGENT's id and the
    // wallet tables only ever permitted `super_agent_id = auth.uid()`.
    const [subAgents, setSubAgents] = useState([]);

    const loadTransactions = useCallback(async () => {
      try {
        const {
          data: { user },
          error: e,
        } = await supabase.auth.getUser();
        if (e || !user) {
          navigation.replace("Login");
          return;
        }
        if (!isSuperAgent) {
          navigation.replace("Home");
          return;
        }
        const { data: s } = await supabase
          .from("super_agent_paystack")
          .select("subaccount_code")
          .eq("super_agent_id", user.id)
          .maybeSingle();
        {
          const c = s?.subaccount_code;
          const { data: tu, error: e1 } = await supabase
            .from("wallet_topups")
            .select("*")
            .eq("agent_id", user.id)
            .order("created_at", { ascending: false })
            .limit(100);
          const { data: od, error: e2 } = await supabase
            .from("payment_transactions")
            .select("*")
            .eq("super_agent_id", user.id)
            .order("created_at", { ascending: false })
            .limit(100);

          if (e1 || e2) throw e1 || e2;
          const a = [];
          (tu || []).forEach((t) =>
            a.push({
              ...t,
              source: "wallet_topup",
              amountDisplay: "Ghc " + Number(t.amount || 0).toFixed(2),
              statusColor:
                t.status === "success"
                  ? colors.success
                  : t.status === "pending"
                    ? colors.warning
                    : colors.danger,
            }),
          );
          (od || []).forEach((o) =>
            a.push({
              ...o,
              source: "data_purchase",
              amountDisplay: "Ghc " + Number(o.gross_amount || 0).toFixed(2),
              statusColor:
                o.status === "completed"
                  ? colors.success
                  : o.status === "pending"
                    ? colors.warning
                    : colors.danger,
            }),
          );

          // =========================================================================
          // Sub-agent activity - ALL of it, every status
          // =========================================================================
          // Previously this fetched exactly one thing:
          //
          //     .from("agent_orders").eq("super_agent_id", user.id).eq("status","held")
          //
          // which is why a super agent saw nothing for a sub-agent who was buying
          // all day. Every dispatched, completed and processing order was
          // invisible; only the failure bucket rendered.
          //
          // Three sources are now merged, because "their transactions" means three
          // different things and the screen used to answer none of them properly:
          //
          //   1. agent_orders         - what was ordered and its live status
          //   2. payment_transactions - the money record for those orders
          //   3. super_agent_wallet_ledger - the actual wallet movements
          //
          // 1 and 2 are joined by order_id and NOT emitted as separate rows,
          // because they describe one purchase between them and rendering both
          // double-counts it in the list. The ledger is separate because a wallet
          // movement is not an order - a top-up, a refund and a mirror rollback
          // are all real movements with no `agent_orders` row at all.
          //
          // Failures are logged per source rather than thrown, so a missing RLS
          // policy on one table cannot blank the other two. That is deliberate:
          // these reads return `[]` on denial (HTTP 200, no error), which is the
          // silent-zero trap - one broken leg must not read as "no activity".
          const [ordersResult, paymentsResult, balancesResult] =
            await Promise.all([
              fetchSubAgentOrders({ superAgentId: user.id, limit: 100 }),
              fetchSubAgentPayments({ superAgentId: user.id, limit: 100 }),
              fetchSubAgentBalances({ superAgentId: user.id }),
            ]);

          const agentOrders = ordersResult || [];
          const agentPayments = paymentsResult || [];
          const roster = balancesResult || [];

          setSubAgents(roster);

          // A payment row carries the settlement split; the order row carries the
          // live delivery status. Merging them gives one card with both, which is
          // what a super agent is actually reconciling against their own wallet.
          const paymentsByOrderId = new Map(
            agentPayments
              .filter((payment) => payment?.order_id != null)
              .map((payment) => [payment.order_id, payment]),
          );

          const nameForAgent = new Map(roster.map((m) => [m.id, m.name]));

          // Marked `orderType: "agent"` so the shared `isReorderableHeldOrder`
          // test accepts the row: it rejects `orderType: "regular"`, and absence
          // means agent_orders.
          const rosterRows = agentOrders.map((order) => {
            const payment = paymentsByOrderId.get(order.id);
            return {
              ...order,
              ...(payment
                ? {
                    transaction_fee: payment.transaction_fee,
                    super_agent_amount: payment.super_agent_amount,
                    agent_net: payment.agent_net,
                    main_account_amount: payment.main_account_amount,
                    settlement_status: payment.settlement_status,
                    gross_amount: payment.gross_amount,
                    // The ORDER's status wins the status pill. `settlement_status`
                    // is the money side and is mirrored onto the ledger row by
                    // dispatch-order; showing it here instead would re-introduce
                    // the "stuck at Pending" confusion this screen already had.
                    status: order.status || payment.status,
                  }
                : {}),
              orderType: "agent",
              source: "sub_agent_order",
              subAgentId: order.agent_id,
              subAgentName: nameForAgent.get(order.agent_id) || "Sub-agent",
              amountDisplay:
                "Ghc " + Number(order.amount || 0).toFixed(2),
              statusColor:
                order.status === "delivered" || order.status === "completed"
                  ? colors.success
                  : order.status === "pending" || order.status === "held"
                    ? colors.warning
                    : colors.info,
            };
          });

          // Ledger movements for the sub-agents' mirrored wallets. Keyed by
          // holder id, so the rows are attributed back to a named sub-agent
          // rather than floating as anonymous wallet ids.
          const ledgerResult = roster.length
            ? await fetchWalletLedger({
                superAgentId: user.id,
                holderIds: roster.map((member) => member.id),
                limit: 100,
              }).catch((error) => {
                console.error("Failed to load sub-agent ledger:", error);
                return [];
              })
            : [];
          const ledgerRows = (ledgerResult || []).map((entry) => ({
            ...entry,
            source: "sub_agent_ledger",
            subAgentName: nameForAgent.get(entry.super_agent_id) || "Sub-agent",
            amountDisplay:
              "Ghc " + Number(entry.amount || 0).toFixed(2),
            // The ledger's own entry_type is the direction; `statusColor` is not
            // meaningful for a movement, so it is left to the credit/debit chip
            // rendered in the card body.
            statusColor: colors.info,
          }));

          // Two lists, not one merged list plus a filter in the render. A single
          // list with a `scope ===` test inside `map()` still builds every row of
          // the other tab's markup and relies on a conditional to hide it, which
          // means the header count and the empty state each have to be filtered
          // independently - three places to keep in step. Holding them apart makes
          // the header and the empty state read the same value the list renders.
          //
          // The roster rows and the ledger movements are merged into one list
          // because a super agent reads them as a single timeline of "what my
          // agents did"; they are distinguished by `source` in the card body
          // rather than by which tab they sit in.
          setRosterTransactions(
            [...rosterRows, ...ledgerRows].sort(
              (x, y) => new Date(y.created_at) - new Date(x.created_at),
            ),
          );
          setOwnTransactions(
            a.filter(
              (row) =>
                row.source === "wallet_topup" || row.source === "data_purchase",
            ),
          );
        }
      } catch (err) {
        console.error(err);
        showError("Error", "Failed to load transactions.");
      } finally {
        setLoading(false);
      }
    }, [navigation, showError]);

    useEffect(() => {
      loadTransactions();
    }, [loadTransactions]);

  // Retries a held order. The window check, the invoke and the error unwrapping
  // live in lib/heldOrderReorder.js so this screen, Home, the Receipt and
  // History cannot drift. Re-reads the list on success so the row's status
  // updates.
  const handleReorder = async (row) => {
    setReorderingId(row.id);
    try {
      const result = await reorderHeldOrder(row);
      if (!result.ok) {
        showError("Reorder Failed", result.message);
        return;
      }
      showSuccess(
        "Order Reordered",
        "The held order was sent to the provider.",
      );
      loadTransactions();
    } finally {
      setReorderingId(null);
    }
  };

    /**
       * Moves a sub-agent's order to a new lifecycle status.
       *
       * Two rules are enforced by the server and are NOT re-implemented here:
       * ownership (the row's `super_agent_id` must be the caller) and the
       * exclusion of the money-moving statuses. Re-deriving either on the client
       * would be a second copy that drifts, and a client that "corrects" the
       * server is how a restriction gets bypassed.
       *
       * Reloads rather than patching local state, because one call can also settle
       * `settlement_status` on BOTH `agent_orders` and `payment_transactions` -
       * two tables this list merges together, and a local patch would leave them
       * disagreeing on screen.
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
          showSuccess("Order updated", `Order marked as ${STATUS_LABELS[status]}.`);
          await loadTransactions();
        } finally {
          setStatusSaving(false);
        }
      };

  const fmt = (d) => {
    try {
      return new Date(d).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return d;
    }
  };

  if (loading)
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </SafeAreaView>
    );

  return (
    <ThemedScreen style={styles.safeArea}>
      <SafeAreaView style={styles.safeArea} edges={["top"]}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backButton}
          >
            <Ionicons name="arrow-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.title}>Transactions</Text>
            <Text style={styles.subtitle}>
              {transactions.length} transaction
              {transactions.length !== 1 ? "s" : ""} found
            </Text>
          </View>
        </View>

                  {/* Two questions, two answers. "My activity" is the super agent's own
                      money and purchases. "My sub-agents" is the roster: their orders,
                      the payment records behind them, their wallet movements and their
                      current balances.

                      The split is not cosmetic. The old screen answered neither question
                      - it showed the super agent's own rows and then bolted on their
                      sub-agents' HELD orders, which is the repair queue rather than the
                      business, so a sub-agent buying all day produced an almost-empty
                      ledger. */}
                  <View style={styles.scopeRow}>
                    {SCOPES.map((option) => {
                      const active = scope === option.key;
                      return (
                        <TouchableOpacity
                          key={option.key}
                          style={[styles.scopeChip, active && styles.scopeChipActive]}
                          onPress={() => setScope(option.key)}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                        >
                          <Text
                            style={[
                              styles.scopeChipText,
                              active && styles.scopeChipTextActive,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Current mirrored balance per sub-agent. Only on the roster tab,
                      because these are the sub-agents' spending ceilings, not the
                      super agent's own balance - showing them next to the real balance
                      would invite the two to be read as one number. */}
                  {scope === "roster" && subAgents.length > 0 ? (
                    <View style={styles.rosterStrip}>
                      <Text style={styles.rosterStripTitle}>
                        {subAgents.length} sub-agent
                        {subAgents.length !== 1 ? "s" : ""} · mirrored balances
                      </Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.rosterStripRow}
                      >
                        {subAgents.map((member) => (
                          <View key={member.id} style={styles.rosterChip}>
                            <Text style={styles.rosterChipName} numberOfLines={1}>
                              {member.name}
                            </Text>
                            <Text style={styles.rosterChipAmount}>
                              Ghc {Number(member.balance || 0).toFixed(2)}
                            </Text>
                          </View>
                        ))}
                      </ScrollView>
                    </View>
                  ) : null}

                  {transactions.length === 0 ? (
                    <View style={styles.emptyContainer}>
                      <Ionicons name="receipt-outline" size={64} color={colors.border} />
                      <Text style={styles.emptyTitle}>
                        {scope === "roster" ? "No Sub-agent Activity" : "No Transactions Yet"}
                      </Text>
                      <Text style={styles.emptyText}>
                        {scope === "roster"
                          ? "Orders your sub-agents place, the payments behind them and their wallet movements will appear here."
                          : "Transactions routed through your Paystack sub-account will appear here."}
                      </Text>
                    </View>
                  ) : (
                    <ScrollView contentContainerStyle={styles.content}>
                      {transactions.map((tx, i) => {
                        // Held orders are the only rows here that can be retried, and the
                        // retry is only valid inside the 24h window.
                        const showReorder = isReorderableHeldOrder(tx);
                        const reorderElapsed = showReorder
                          ? isHeldWindowElapsed(tx, Date.now())
                          : false;
                        const reorderBusy = reorderingId === tx.id;
                        const typeLabel =
                          tx.source === "wallet_topup"
                            ? "Wallet Top-up"
                            : tx.source === "sub_agent_order"
                              ? "Sub-agent Order"
                              : tx.source === "sub_agent_ledger"
                                ? "Wallet Movement"
                                : "Data Purchase";
                        const icon =
                          tx.source === "wallet_topup"
                            ? "wallet"
                            : tx.source === "sub_agent_order"
                              ? "cart-outline"
                              : tx.source === "sub_agent_ledger"
                                ? "swap-horizontal-outline"
                                : "phone-portrait";

              return (
                <View key={i} style={styles.txCard}>
                  <View style={styles.txHeader}>
                    <View style={styles.txIconWrap}>
                      <Ionicons name={icon} size={22} color={colors.primary} />
                    </View>
                    <View style={styles.txMeta}>
                      <Text style={styles.txType}>{typeLabel}</Text>
                      <Text style={styles.txDate}>{fmt(tx.created_at)}</Text>
                    </View>
                    <View
                      style={[
                        styles.txStatus,
                        { backgroundColor: tx.statusColor },
                      ]}
                    >
                      <Text style={styles.txStatusText}>
                        {String(
                          tx.jehuca_order_status || tx.status || "unknown",
                        ).toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.txBody}>
                    <View style={styles.txInfoRow}>
                      <Text style={styles.txInfoLabel}>Reference</Text>
                      <Text style={styles.txInfoValue} numberOfLines={1}>
                        {tx.reference || tx.id?.toString().slice(0, 12)}
                      </Text>
                    </View>
                    <View style={styles.txInfoRow}>
                      <Text style={styles.txInfoLabel}>Amount</Text>
                      <Text style={styles.txInfoValueBold}>
                        {tx.amountDisplay}
                      </Text>
                    </View>
                    {tx.paystack_transaction_id && (
                      <View style={styles.txInfoRow}>
                        <Text style={styles.txInfoLabel}>Paystack TX ID</Text>
                        <Text style={styles.txInfoValue} numberOfLines={1}>
                          {tx.paystack_transaction_id}
                        </Text>
                      </View>
                    )}
                    {tx.channel && (
                      <View style={styles.txInfoRow}>
                        <Text style={styles.txInfoLabel}>Channel</Text>
                        <Text style={styles.txInfoValue}>{tx.channel}</Text>
                      </View>
                    )}
                    {tx.source === "data_purchase" && (
                      <>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Sub-agent</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.agent_id || "N/A"}
                          </Text>
                        </View>
                        {/* `payment_transactions.recipient_phone` is written by
                            verify-payment for every row, but this card never
                            showed it, so a super agent could not see who they
                            bought data for without opening each transaction. */}
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Recipient</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.recipient_phone || "N/A"}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Base share</Text>
                          <Text style={styles.txInfoValue}>
                            Ghc {Number(tx.base_amount || 0).toFixed(2)}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>
                            Transaction fee
                          </Text>
                          <Text style={styles.txInfoValue}>
                            Ghc {Number(tx.transaction_fee || 0).toFixed(2)}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Your share</Text>
                          <Text style={styles.txInfoValue}>
                            Ghc {Number(tx.super_agent_amount || 0).toFixed(2)}
                          </Text>
                        </View>
                        {tx.jehuca_order_id && (
                          <View style={styles.txInfoRow}>
                            <Text style={styles.txInfoLabel}>Jehuca order</Text>
                            <Text style={styles.txInfoValue}>
                              {tx.jehuca_order_id}
                            </Text>
                          </View>
                        )}
                      </>
                    )}
                    {tx.source === "sub_agent_order" && (
                      <>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Sub-agent</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.subAgentName}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Recipient</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.recipient_phone || "N/A"}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Network</Text>
                          <Text style={styles.txInfoValue}>
                            {String(tx.network || "N/A").toUpperCase()}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Package</Text>
                          <Text style={styles.txInfoValue} numberOfLines={1}>
                            {tx.offer_title || "N/A"}
                          </Text>
                        </View>
                        {/* The settlement split, so the super agent can check
                            the card against what actually left their wallet.
                            Rendered only when the payment record was found:
                            these are the ledger's columns, and showing "Ghc
                            0.00" for a missing join would read as a real
                            zero rather than as absent data. */}
                        {tx.super_agent_amount != null ? (
                          <View style={styles.txInfoRow}>
                            <Text style={styles.txInfoLabel}>Your share</Text>
                            <Text style={styles.txInfoValue}>
                              Ghc{" "}
                              {Number(tx.super_agent_amount || 0).toFixed(2)}
                            </Text>
                          </View>
                        ) : null}
                        {tx.transaction_fee != null ? (
                          <View style={styles.txInfoRow}>
                            <Text style={styles.txInfoLabel}>Paystack fee</Text>
                            <Text style={styles.txInfoValue}>
                              Ghc {Number(tx.transaction_fee || 0).toFixed(2)}
                            </Text>
                          </View>
                        ) : null}
                        {tx.payment_reference ? (
                          <View style={styles.txInfoRow}>
                            <Text style={styles.txInfoLabel}>Reference</Text>
                            <Text style={styles.txInfoValue} numberOfLines={1}>
                              {tx.payment_reference}
                            </Text>
                          </View>
                        ) : null}

                        {/* Status control. Only on this row type, because it is
                            the only one where the super agent is the customer
                            of record - their own purchases and top-ups are
                            already resolved and need no input.

                            The option list is deliberately short. Cancelling and
                            refunding are NOT here because they release wallet
                            money, and the super agent is the party that money
                            would come back to. Support handles those. */}
                        {statusEditingId === tx.id ? (
                          <View style={styles.statusPicker}>
                            {SUPER_AGENT_WRITABLE_STATUSES.map((option) => {
                              const isCurrent =
                                String(tx.status || "").toLowerCase() ===
                                option.value;
                              return (
                                <TouchableOpacity
                                  key={option.value}
                                  style={[
                                    styles.statusOption,
                                    isCurrent && styles.statusOptionCurrent,
                                  ]}
                                  disabled={statusSaving}
                                  onPress={() =>
                                    handleStatusChange(tx.id, option.value)
                                  }
                                  activeOpacity={0.85}
                                  accessibilityRole="button"
                                  accessibilityLabel={`Mark order as ${option.label}`}
                                >
                                  <Text
                                    style={[
                                      styles.statusOptionText,
                                      isCurrent && styles.statusOptionTextCurrent,
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
                            style={styles.statusButton}
                            onPress={() => setStatusEditingId(tx.id)}
                            activeOpacity={0.85}
                            accessibilityRole="button"
                            accessibilityLabel={`Update status of order ${tx.id}`}
                          >
                            <Ionicons
                              name="create-outline"
                              size={15}
                              color={colors.white}
                            />
                            <Text style={styles.statusButtonText}>
                              Update status
                            </Text>
                          </TouchableOpacity>
                        )}
                      </>
                    )}

                    {tx.source === "sub_agent_ledger" && (
                      <>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Sub-agent</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.subAgentName}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Reason</Text>
                          <Text style={styles.txInfoValue}>
                            {ledgerReasonLabel(tx.reason)}
                          </Text>
                        </View>
                        {/* A ledger movement's direction is `entry_type`, not
                            its sign alone: the amount column stores credits
                            positive and debits negative, but the explicit
                            column is what the constraint enforces and what
                            every other reader uses. */}
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Type</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.entry_type === "credit" ? "CREDIT" : "DEBIT"}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Balance before</Text>
                          <Text style={styles.txInfoValue}>
                            Ghc{" "}
                            {Number(tx.balance_before || 0).toFixed(2)}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Balance after</Text>
                          <Text style={styles.txInfoValue}>
                            Ghc {Number(tx.balance_after || 0).toFixed(2)}
                          </Text>
                        </View>
                      </>
                    )}

                    {tx.source === "held_order" && (
                      <>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Recipient</Text>
                          <Text style={styles.txInfoValue}>
                            {tx.recipient_phone || "N/A"}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Network</Text>
                          <Text style={styles.txInfoValue}>
                            {String(tx.network || "N/A").toUpperCase()}
                          </Text>
                        </View>
                        <View style={styles.txInfoRow}>
                          <Text style={styles.txInfoLabel}>Package</Text>
                          <Text style={styles.txInfoValue} numberOfLines={1}>
                            {tx.offer_title || "N/A"}
                          </Text>
                        </View>
                        {tx.payment_reference && (
                          <View style={styles.txInfoRow}>
                            <Text style={styles.txInfoLabel}>Reference</Text>
                            <Text style={styles.txInfoValue} numberOfLines={1}>
                              {tx.payment_reference}
                            </Text>
                          </View>
                        )}
                      </>
                    )}

                    {/* Retry. A held order means the customer PAID and our
                      internal wallet debit failed, so this is the only thing
                      that moves the order forward - and it is only valid
                      inside the 24h window. */}
                    {showReorder ? (
                      <TouchableOpacity
                        style={[
                          styles.reorderButton,
                          reorderElapsed && styles.reorderButtonClosed,
                        ]}
                        onPress={() => handleReorder(tx)}
                        disabled={reorderBusy || reorderElapsed}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityLabel={
                          reorderElapsed
                            ? "Reorder window closed"
                            : "Reorder this held order"
                        }
                      >
                        {reorderBusy ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.white}
                          />
                        ) : (
                          <Ionicons
                            name="refresh"
                            size={17}
                            color={
                              reorderElapsed ? colors.border : colors.white
                            }
                          />
                        )}
                        <Text
                          style={[
                            styles.reorderText,
                            reorderElapsed && styles.reorderTextClosed,
                          ]}
                        >
                          {reorderElapsed
                            ? "Reorder window closed"
                            : reorderBusy
                              ? "Reordering…"
                              : "Reorder this order"}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
      </SafeAreaView>
    </ThemedScreen>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.light },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.light,
  },
  loadingText: {
    marginTop: 12,
    color: colors.dark,
    fontSize: 16,
    fontWeight: "600",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 12,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  headerCenter: { flex: 1 },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.dark },
  subtitle: { fontSize: 12, color: colors.border, marginTop: 2 },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
    gap: 12,
  },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: colors.dark },

  // Scope toggle
  scopeRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  scopeChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.light,
    borderWidth: 1,
    borderColor: colors.border,
  },
  scopeChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  scopeChipText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.border,
  },
  scopeChipTextActive: { color: colors.white },

  // Mirrored-balance strip
  rosterStrip: {
    paddingTop: 12,
    paddingBottom: 14,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rosterStripTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.border,
    paddingHorizontal: 16,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  rosterStripRow: { paddingHorizontal: 16, gap: 10 },
  rosterChip: {
    minWidth: 128,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.light,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  rosterChipName: { fontSize: 12, fontWeight: "600", color: colors.border },
  rosterChipAmount: { fontSize: 15, fontWeight: "800", color: colors.dark },

  // Status control
  statusButton: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: colors.primary,
  },
  statusButtonText: {
    color: colors.white,
    fontWeight: "700",
    fontSize: 13,
  },
  statusPicker: {
    marginTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  statusOption: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: colors.light,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusOptionCurrent: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  },
  statusOptionText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.border,
  },
  statusOptionTextCurrent: { color: colors.white },
  emptyText: {
    fontSize: 14,
    color: colors.border,
    textAlign: "center",
    lineHeight: 22,
  },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  txCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  txHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  txIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  txMeta: { flex: 1 },
  txType: { fontSize: 14, fontWeight: "700", color: colors.dark },
  txDate: { fontSize: 12, color: colors.border, marginTop: 2 },
  txStatus: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  txStatusText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fff",
    textTransform: "uppercase",
  },
  txBody: { borderTopWidth: 1, borderTopColor: colors.light, paddingTop: 10 },
  txInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 3,
  },
  txInfoLabel: { fontSize: 12, color: colors.border },
  txInfoValue: {
    fontSize: 12,
    color: colors.dark,
    fontWeight: "500",
    flex: 1,
    textAlign: "right",
  },
  txInfoValueBold: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: "700",
    flex: 1,
    textAlign: "right",
  },

  // ---------- Reorder (held orders) ----------
  reorderButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  reorderButtonClosed: { backgroundColor: colors.light },
  reorderText: { fontSize: 14, fontWeight: "700", color: colors.white },
  reorderTextClosed: { color: colors.border },
});
