import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../contexts/ThemeContext";
import { useProfile } from "../contexts/ProfileContext";
import { useNotification } from "../contexts/NotificationContext";
import { supabase } from "../lib/supabase";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import {
  fetchFullWalletLedger,
  formatLedgerAmount,
  ledgerActorLabel,
  ledgerEntryLabel,
  ledgerReasonLabel,
  summariseLedger,
} from "../lib/superAgentRoster";
import { fonts } from "../components/theme";
import {
  EmptyState,
  RowIcon,
  ScreenHeader,
  ThemedScreen,
  useThemedStyles,
} from "../components/ui";

// ===========================================================================
// Super Agent wallet ledger
// ===========================================================================
// WHY THIS IS A SEPARATE SCREEN
// ----------------------------
// The Transactions screen answers "what did my sub-agents buy". This one
// answers a different question: "what happened to my money".
//
// `super_agent_wallet_ledger` is the ONLY complete record of that. Every credit
// and debit passes through it, including the ones with no order behind them - an
// admin top-up, a mirror rollback, a refund - so a list built from orders or
// top-ups cannot be made to balance. A super agent whose wallet is short needs
// to reconcile, and reconciling against a derived total is how a real shortfall
// goes unnoticed for a month.
//
// The two are also not interchangeable as data: the ledger is keyed on the
// wallet HOLDER, so a sub-agent's mirrored movements sit under the sub-agent's
// id and are invisible to a `super_agent_id = <caller>` read. That is a
// structural reason this could not be a tab on the Transactions screen.
//
// WHY NO FILTERS YET
// -----------------
// Tempting, and deliberately absent. Every entry carries `balance_before` and
// `balance_after`, so a filtered view silently breaks the running balance it
// displays unless the filter is applied to a contiguous slice - and a
// date-range or entry-type filter almost never is. Showing a balance that does
// not correspond to the rows above it is worse than showing every row. The
// totals at the top are computed from the full set for the same reason.
//
// If filters are added later, they must be paired with a recomputed opening
// balance, never with the unfiltered one.

const PAGE_SIZE = 100;

const formatDate = (dateString) => {
  if (!dateString) return "";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const useLedgerStyles = (c, topInset) => useMemo(() => buildStyles(c, topInset), [c, topInset]);

const formatGhc = (value) =>
  `Ghc ${Number(value || 0).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// Local, not in `components/ui.js`. The shared `themedStyles` covers rows and
// headers; a financial statement needs a summary block and per-row running
// balances that nothing else on the app uses, and adding them there would mean
// every other screen carries style keys it never reads.
//
// `topInset` is the Android status-bar height. The app is edge-to-edge there
// with no navigator header, so the screen has to inset itself or the header
// sits under the status bar and its title is unreadable. iOS already spaces
// this, so the inset is Android-only - the same rule, and the same reason, as
// HistoryScreen and SuperAgentHeldOrdersScreen.
const buildStyles = (c, topInset = 0) =>
  StyleSheet.create({
    summaryCard: {
      backgroundColor: c.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 18,
      marginTop: 4,
      marginBottom: 18,
    },
    summaryLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 11.5,
      color: c.textMuted,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    summaryValue: {
      fontFamily: fonts.display,
      fontSize: 32,
      marginTop: 6,
    },
    summaryFoot: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 6,
    },
    summaryDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.hairline,
      marginVertical: 14,
    },
    summaryRow: {
      flexDirection: "row",
      gap: 12,
    },
    summaryCell: {
      flex: 1,
    },
    summaryCellValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 15,
    },
    summaryCellLabel: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.textMuted,
      marginTop: 3,
    },
    rowAmount: {
      fontFamily: fonts.bodySemi,
      fontSize: 14.5,
      textAlign: "right",
    },
    rowBalance: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.textMuted,
      textAlign: "right",
      marginTop: 3,
    },
    rowFlag: {
      fontFamily: fonts.bodySemi,
      fontSize: 10,
      color: c.textMuted,
      textAlign: "right",
      marginTop: 4,
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    rowReference: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 3,
    },
    skeletonLine: {
      height: 12,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
      width: "70%",
    },
    skeletonLineShort: {
      height: 10,
      borderRadius: 5,
      backgroundColor: c.surfaceHover,
      width: "45%",
      marginTop: 8,
    },
        // `flex: 1` so the ScrollView still fills the screen and scrolls, rather
        // than collapsing to its content height under the padded wrapper.
        insetTop: {
          flex: 1,
          paddingTop: topInset,
        },
      });

export default function SuperAgentLedgerScreen({ navigation }) {
  const { c, isDark } = useTheme();
  const { styles } = useThemedStyles();
  const { isNormalUser, isSuperAgent } = useProfile();
  const { showError } = useNotification();
  const dockPadding = useDockBottomPadding(16);
  const insets = useSafeAreaInsets();
  // Must be declared BEFORE `local`, which consumes it. Reading it above the
  // declaration is a temporal dead zone access and throws at render - not a
  // silent undefined, so it fails loudly rather than shipping a broken inset.
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const local = useLedgerStyles(c, topInset);

  const [entries, setEntries] = useState([]);
  const [subAgentNames, setSubAgentNames] = useState({});
  // Reference -> funder id, for top-ups whose ledger row predates
  // `metadata.funded_by`. See `fetchTopupFunders`.
  const [funders, setFunders] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ownerId, setOwnerId] = useState(null);

  const load = useCallback(
    async ({ refresh = false } = {}) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);

      try {
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser();

        if (error || !user) {
          // Replaces the current route rather than pushing, so Back does not
          // return to a screen that now requires a session it no longer has.
          navigation.replace("Login");
          return;
        }

        // Guarded on "is not a normal user", NOT on `isSuperAgent`.
                //
                // The Home drawer offers this to every account that holds a wallet, and
                // that is the correct set: a SUB-AGENT's mirrored balance is a wallet
                // they spend from, and this is the only record of how it moved. Gating
                // on `isSuperAgent` would leave a visible entry that redirects them away
                // on arrival - a dead tap, the same failure the Wallet Top-up drawer
                // entry was removed for.
                //
                // Role from `public.user_profiles`, matching every other screen. It is
                // only a presentation guard; the rows themselves are already scoped by
                // RLS, which resolves each caller's own ledger and their own sub-agents'
                // and nothing else.
                if (isNormalUser) {
                  navigation.replace("Home");
                  return;
                }

                setOwnerId(user.id);

                const warnings = [];
                // Returns `{ entries, roster, funders }` rather than a bare array,
                // so the names and the movements come from ONE resolution of the
                // roster. Fetching them separately would let a reassignment between
                // the two reads leave a movement attributed to whoever used to hold
                // that wallet.
                const {
                  entries: rows,
                  roster,
                  funders,
                } = await fetchFullWalletLedger({
                  superAgentId: user.id,
                  limit: PAGE_SIZE,
                  onWarning: (message) => warnings.push(message),
                });
                // Each wallet holder gets a label, so a movement on a mirrored wallet
                // is attributable rather than showing as a bare uuid.
                //
                // "Your wallet" rather than the caller's own name: on a statement about
                // your own balance, printing your legal name is noise, and this row IS
                // yours. A caller whose mirrored balance is their own spending power
                // reads the same way, which is correct - the ledger is keyed on the
                // wallet HOLDER either way.
                //
                // Built from the roster rather than from the rows, so a sub-agent with
                // no movements still appears in the map if a later one does.
                const names = {};
                roster.forEach((member) => {
                  if (member?.id) names[member.id] = member.name;
                });
                if (!names[user.id]) names[user.id] = "Your wallet";

                // A holder the roster does not know - a sub-agent removed from the team
                // after the movement, or one whose profile row failed RLS - still gets
                // a readable label. "Sub-agent" is honest about that; a uuid is not.
                rows.forEach((row) => {
                  const holder = row.super_agent_id;
                  if (holder && !names[holder]) names[holder] = "Sub-agent";
                });

                setSubAgentNames(names);
                // The funder map is keyed on `reference`, so it has no entry for
                // every row. An absent one is not an error - most movements
                // (order debits, refunds, admin adjustments) record no funder at
                // all, and the row is then labelled from its holder alone.
                setFunders(funders || {});
                setEntries(rows);

        // Surfaced rather than swallowed: the ledger read fails CLOSED and
        // SILENTLY on a missing policy (HTTP 200, zero rows), which is
        // indistinguishable from "no movements yet".
        const first = warnings[0];
        if (first) showError("Ledger Incomplete", first);
      } catch (error) {
        console.error("Could not load the wallet ledger:", error);
        showError(
          "Ledger Unavailable",
          error?.message || "Could not load your wallet ledger.",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [isNormalUser, navigation, showError],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Computed from the rows actually rendered, so the header can never claim a
  // total the list below it does not add up to.
  const summary = useMemo(() => summariseLedger(entries), [entries]);

  const closing = summary.closing ?? summary.opening ?? 0;

  return (
    <ThemedScreen style={styles.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

          {/*
                  The inset is applied to a wrapper around the header and the list, not
                  to the ScrollView. `ScreenHeader` is a plain View with no inset
                  handling, so padding on the scroll body alone would leave the title
                  itself under the status bar - the padding would only push the summary
                  card down.

                  Wrapping both means the whole column starts below the status bar, which
                  is what the screen looks like on iOS already.
                */}
                <View style={local.insetTop}>
                  <ScreenHeader
                    title="Wallet Ledger"
                    subtitle={
                      loading
                        ? "Loading movements…"
                        : entries.length === 0
                          ? "No movements yet"
                          : `${entries.length} movement${entries.length === 1 ? "" : "s"}`
                    }
                    onBack={() => navigation.goBack()}
                  />

                  <ScrollView
                    contentContainerStyle={[styles.body, { paddingBottom: dockPadding }]}
                    showsVerticalScrollIndicator={false}
                    refreshControl={
                      <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => load({ refresh: true })}
                        tintColor={c.mint}
                        colors={[c.mint]}
                      />
                    }
                  >
                    <View style={local.summaryCard}>
                      <Text style={local.summaryLabel}>Available balance</Text>
                      <Text style={[local.summaryValue, { color: c.mint }]}>
                        {formatGhc(closing)}
                      </Text>

                      {/*
                        The opening balance is only shown when the ledger actually carries
                        one. Rendering "Ghc 0.00" for a brand-new wallet would state a fact
                        the database has never asserted, and a super agent reconciling a
                        statement cannot tell that apart from a real zero.
                      */}
                      {summary.opening != null ? (
                        <Text style={local.summaryFoot}>
                          From {formatGhc(summary.opening)} ·{" "}
                          {summary.net >= 0 ? "+" : "-"}
                          {formatGhc(Math.abs(summary.net))} net
                        </Text>
                      ) : null}

                      <View style={local.summaryDivider} />

                      <View style={local.summaryRow}>
                        <View style={local.summaryCell}>
                          <Text style={[local.summaryCellValue, { color: c.mint }]}>
                            +{formatGhc(summary.credits)}
                          </Text>
                          <Text style={local.summaryCellLabel}>Money in</Text>
                        </View>
                        <View style={local.summaryCell}>
                          <Text style={[local.summaryCellValue, { color: c.rose }]}>
                            -{formatGhc(summary.debits)}
                          </Text>
                          <Text style={local.summaryCellLabel}>Money out</Text>
                        </View>
                      </View>
                    </View>

                    {loading ? (
                      <View style={styles.cardDivided}>
                        {[0, 1, 2, 3].map((index) => (
                          <View key={`ledger-skeleton-${index}`} style={styles.row}>
                            <View style={styles.rowBody}>
                              <View style={local.skeletonLine} />
                              <View style={local.skeletonLineShort} />
                            </View>
                          </View>
                        ))}
                      </View>
                    ) : entries.length === 0 ? (
                      <EmptyState
                        icon="swap-horizontal-outline"
                        title="No wallet movements yet"
                        message="Every credit and debit to your wallet will appear here, including your sub-agents' purchases and any refunds."
                      />
                    ) : (
                      <View style={styles.cardDivided}>
                        {entries.map((entry, index) => {
                          const isCredit =
                            String(entry.entry_type || "").trim().toLowerCase() ===
                            "credit";
                          /*
                            The HOLDER alone is not enough to describe a row.
                            A sub-agent's top-up writes a credit to the SUPER
                            AGENT's own wallet, so the holder is "Your wallet"
                            on the one movement where the interesting fact is
                            that someone else paid for it. `ledgerActorLabel`
                            reads the funder out of the row's metadata and
                            names them, which is the whole point of this
                            statement: reconciling "Ghc 500 in" against "Ghc 500
                            received from Kofi" is what turns a balance into a
                            record.
                          */
                          const actorLabel = ledgerActorLabel(entry, {
                            names: subAgentNames,
                            currentUserId: ownerId,
                            funders,
                            isSuperAgent,
                          });
                          const isOwn = String(entry.super_agent_id) === String(ownerId);

                          return (
                            <View key={entry.id}>
                              {/*
                                The divider sits above every row but the first, so the
                                card reads as one list rather than as separate cards.
                              */}
                              {index > 0 ? <View style={styles.rowDivider} /> : null}
                              <View style={styles.row} accessibilityRole="summary">
                                <RowIcon
                                  icon={isCredit ? "arrow-down" : "arrow-up"}
                                  tint={isCredit ? c.mint : c.amber}
                                />

                                <View style={styles.rowBody}>
                                  <Text style={styles.rowTitle} numberOfLines={1}>
                                    {ledgerReasonLabel(entry.reason)}
                                  </Text>
                                  <Text style={styles.rowSubtitle} numberOfLines={2}>
                                    {ledgerEntryLabel(entry.entry_type)} · {actorLabel}
                                    {formatDate(entry.created_at)
                                      ? ` · ${formatDate(entry.created_at)}`
                                      : ""}
                                  </Text>
                                  {entry.reference ? (
                                    <Text style={local.rowReference} numberOfLines={1}>
                                      {entry.reference}
                                    </Text>
                                  ) : null}
                                </View>

                                <View style={styles.rowBody}>
                                  <Text
                                    style={[
                                      local.rowAmount,
                                      { color: isCredit ? c.mint : c.amber },
                                    ]}
                                  >
                                    {formatLedgerAmount(entry)}
                                  </Text>
                                  {/*
                                    The running balance is per-entry, so it belongs on the
                                    row rather than in the summary: a reader checking an
                                    old entry is answering "what did I have at that point",
                                    which a single current total cannot answer.
                                  */}
                                  {entry.balance_after != null ? (
                                    <Text style={local.rowBalance}>
                                      Bal {formatGhc(entry.balance_after)}
                                    </Text>
                                  ) : null}
                                  {!isOwn ? (
                                    <Text style={local.rowFlag}>Mirrored</Text>
                                  ) : null}
                                </View>
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </ScrollView>
                </View>
              </ThemedScreen>
            );
          }
