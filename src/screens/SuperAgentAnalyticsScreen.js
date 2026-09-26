import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import { fonts } from "../components/theme";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";

const money = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;
const count = (value) => Number(value || 0).toLocaleString();

const EMPTY_ANALYTICS = {
  earnings: { today: 0, week: 0, month: 0, year: 0, all_time: 0 },
  sub_agent_sales: {
    transaction_count: 0,
    gross_sales: 0,
    base_cost: 0,
    markup_earnings: 0,
    platform_fees: 0,
    super_agent_revenue: 0,
    active_sub_agents: 0,
    held_count: 0,
    cancelled_count: 0,
  },
  super_agent_purchases: {
    transaction_count: 0,
    wallet_spend: 0,
    base_cost: 0,
    cancelled_count: 0,
  },
  wallets: {
    current_balance: 0,
    funded_wallet_count: 0,
    current_month_credits: 0,
    current_month_debits: 0,
    net_wallet_funding: 0,
  },
  afa: {
    transaction_count: 0,
    net_collected: 0,
    paystack_collected: 0,
    wallet_spend: 0,
  },
  sub_agents: [],
  daily_trend: [],
};

const TrendChart = ({ data }) => {
  const theme = useTheme();
  const styles = useAnalyticsStyles(theme.c);
  const normalized = useMemo(() => {
    const byDay = new Map(
      (data || []).map((row) => [String(row.day).slice(0, 10), row]),
    );
    return Array.from({ length: 14 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (13 - index));
      const key = date.toISOString().slice(0, 10);
      return byDay.get(key) || { day: key, earnings: 0 };
    });
  }, [data]);
  const maximum = Math.max(
    ...normalized.map((row) => Number(row.earnings || 0)),
    1,
  );

  return (
    <ThemedScreen style={styles.chart}>
      <View style={styles.chartBars}>
        {normalized.map((row, index) => {
          const value = Number(row.earnings || 0);
          return (
            <View key={row.day} style={styles.barColumn}>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.bar,
                    {
                      height: Math.max(4, (value / maximum) * 104),
                      opacity: index === normalized.length - 1 ? 1 : 0.45,
                    },
                  ]}
                />
              </View>
              {index % 3 === 0 || index === normalized.length - 1 ? (
                <Text style={styles.barLabel}>
                  {new Date(row.day).toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                  })}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </ThemedScreen>
  );
};

const MetricCard = ({ icon, label, value, detail, tone }) => {
  const theme = useTheme();
  const styles = useAnalyticsStyles(theme.c);
  const accent = tone || theme.c.mint;
  return (
    <View style={styles.metricCard}>
      <View style={[styles.metricIcon, { backgroundColor: `${accent}1F` }]}>
        <Ionicons name={icon} size={21} color={accent} />
      </View>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color: accent }]}>{value}</Text>
      {detail ? <Text style={styles.metricDetail}>{detail}</Text> : null}
    </View>
  );
};

export default function SuperAgentAnalyticsScreen({ navigation }) {
  const { showError } = useNotification();
  const theme = useTheme();
  const c = theme.c;
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useAnalyticsStyles(c, topInset);
  const [analytics, setAnalytics] = useState(EMPTY_ANALYTICS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadAnalytics = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          navigation.replace("Login");
          return;
        }
        if (!isSuperAgent(user)) {
          navigation.replace("Home");
          return;
        }

        const { data, error } = await supabase.rpc("get_business_analytics");
        if (error) throw error;
        setAnalytics({ ...EMPTY_ANALYTICS, ...(data || {}) });
      } catch (error) {
        console.error("Error loading Super Agent analytics:", error);
        showError(
          "Analytics unavailable",
          error?.message || "Please apply the latest database migration.",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [navigation, showError],
  );

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const earnings = analytics.earnings || EMPTY_ANALYTICS.earnings;
  const subAgentSales =
    analytics.sub_agent_sales || EMPTY_ANALYTICS.sub_agent_sales;
  const ownPurchases =
    analytics.super_agent_purchases || EMPTY_ANALYTICS.super_agent_purchases;
  const wallet = analytics.wallets || EMPTY_ANALYTICS.wallets;
  const afa = analytics.afa || EMPTY_ANALYTICS.afa;
  const totalTransactions =
    Number(subAgentSales.transaction_count || 0) +
    Number(ownPurchases.transaction_count || 0);
  const totalCollected =
    Number(subAgentSales.gross_sales || 0) +
    Number(ownPurchases.wallet_spend || 0);

  return (
    <ThemedScreen style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={c.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>SUPER AGENT</Text>
          <Text style={styles.title}>Business Analytics</Text>
        </View>
        <TouchableOpacity
          onPress={() => loadAnalytics(true)}
          style={styles.refreshButton}
          accessibilityLabel="Refresh analytics"
        >
          <Ionicons name="refresh" size={21} color={c.mint} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={c.mint} />
          <Text style={styles.loadingText}>Calculating your business...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadAnalytics(true)}
              tintColor={c.mint}
            />
          }
        >
          <View style={styles.heroCard}>
            <View style={styles.heroTopline}>
              <View>
                <Text style={styles.heroLabel}>
                  All-time Super Agent earnings
                </Text>
                <Text style={styles.heroValue}>{money(earnings.all_time)}</Text>
              </View>
              <View style={styles.heroIcon}>
                <Ionicons name="trending-up" size={26} color={c.heroText} />
              </View>
            </View>
            <Text style={styles.heroDescription}>
              Base data cost plus markup from active sub-agent sales. Cancelled
              and failed orders are excluded.
            </Text>
          </View>

          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Earnings pace</Text>
              <Text style={styles.sectionSubtitle}>
                Base cost plus markup earnings
              </Text>
            </View>
            <Ionicons name="analytics" size={22} color={c.mint} />
          </View>
          <View style={styles.periodGrid}>
            <MetricCard
              icon="sunny-outline"
              label="Today"
              value={money(earnings.today)}
            />
            <MetricCard
              icon="calendar-outline"
              label="This week"
              value={money(earnings.week)}
            />
            <MetricCard
              icon="calendar-number-outline"
              label="This month"
              value={money(earnings.month)}
            />
            <MetricCard
              icon="trophy-outline"
              label="This year"
              value={money(earnings.year)}
            />
          </View>

          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>14-day earnings trend</Text>
              <Text style={styles.sectionSubtitle}>
                Daily Super Agent earnings
              </Text>
            </View>
            <View style={styles.livePill}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          </View>
          <View style={styles.panel}>
            <TrendChart data={analytics.daily_trend} />
          </View>

          <Text style={styles.sectionTitle}>Business totals</Text>
          <View style={styles.totalCard}>
            <View style={styles.totalRow}>
              <View style={styles.totalIcon}>
                <Ionicons name="git-network-outline" size={22} color={c.mint} />
              </View>
              <View style={styles.totalCopy}>
                <Text style={styles.totalLabel}>Sub-agent transactions</Text>
                <Text style={styles.totalHint}>
                  {count(subAgentSales.active_sub_agents)} active sub-agents
                </Text>
              </View>
              <Text style={styles.totalValue}>
                {count(subAgentSales.transaction_count)}
              </Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.totalRow}>
              <View style={styles.totalIcon}>
                <Ionicons
                  name="phone-portrait-outline"
                  size={22}
                  color={c.sky}
                />
              </View>
              <View style={styles.totalCopy}>
                <Text style={styles.totalLabel}>
                  Your Data Screen purchases
                </Text>
                <Text style={styles.totalHint}>Wallet-funded packages</Text>
              </View>
              <Text style={styles.totalValue}>
                {count(ownPurchases.transaction_count)}
              </Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.totalRow}>
              <View style={styles.totalIcon}>
                <Ionicons name="layers-outline" size={22} color={c.amber} />
              </View>
              <View style={styles.totalCopy}>
                <Text style={styles.totalLabel}>All data transactions</Text>
                <Text style={styles.totalHint}>
                  Sub-agent and Super Agent purchases
                </Text>
              </View>
              <Text style={styles.totalValue}>{count(totalTransactions)}</Text>
            </View>
          </View>

          <View style={styles.breakdownGrid}>
            <View style={styles.breakdownCard}>
              <Text style={styles.breakdownLabel}>Total sub-agent sales</Text>
              <Text style={styles.breakdownValue}>
                {money(subAgentSales.gross_sales)}
              </Text>
              <Text style={styles.breakdownHint}>Gross customer payments</Text>
            </View>
            <View style={styles.breakdownCard}>
              <Text style={styles.breakdownLabel}>Total markup earnings</Text>
              <Text style={[styles.breakdownValue, { color: c.sky }]}>
                {money(subAgentSales.markup_earnings)}
              </Text>
              <Text style={styles.breakdownHint}>Your realized margin</Text>
            </View>
            <View style={styles.breakdownCard}>
              <Text style={styles.breakdownLabel}>Your package spend</Text>
              <Text style={styles.breakdownValue}>
                {money(ownPurchases.wallet_spend)}
              </Text>
              <Text style={styles.breakdownHint}>Data Screen purchases</Text>
            </View>
            <View style={styles.breakdownCard}>
              <Text style={styles.breakdownLabel}>Total business value</Text>
              <Text style={styles.breakdownValue}>{money(totalCollected)}</Text>
              <Text style={styles.breakdownHint}>Sales + own purchases</Text>
            </View>
          </View>

          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Operational analytics</Text>
              <Text style={styles.sectionSubtitle}>
                Wallet, fees, and order health
              </Text>
            </View>
          </View>
          <View style={styles.operationsCard}>
            <View style={styles.operationRow}>
              <View style={styles.operationIcon}>
                <Ionicons name="wallet-outline" size={20} color={c.mint} />
              </View>
              <View style={styles.operationCopy}>
                <Text style={styles.operationLabel}>Super Agent wallet</Text>
                <Text style={styles.operationHint}>
                  Operational balance, not sub-agent revenue
                </Text>
              </View>
              <Text style={styles.operationValue}>
                {money(wallet.current_balance)}
              </Text>
            </View>
            <View style={styles.operationRow}>
              <View style={styles.operationIcon}>
                <Ionicons name="cash-outline" size={20} color={c.sky} />
              </View>
              <View style={styles.operationCopy}>
                <Text style={styles.operationLabel}>Wallet funding</Text>
                <Text style={styles.operationHint}>
                  Successful top-ups, all time
                </Text>
              </View>
              <Text style={styles.operationValue}>
                {money(wallet.net_wallet_funding)}
              </Text>
            </View>
            <View style={styles.operationRow}>
              <View style={styles.operationIcon}>
                <Ionicons name="card-outline" size={20} color={c.amber} />
              </View>
              <View style={styles.operationCopy}>
                <Text style={styles.operationLabel}>
                  Platform transaction fees
                </Text>
                <Text style={styles.operationHint}>
                  Collected from sub-agent sales
                </Text>
              </View>
              <Text style={styles.operationValue}>
                {money(subAgentSales.platform_fees)}
              </Text>
            </View>
            <View style={styles.operationRow}>
              <View style={styles.operationIcon}>
                <Ionicons
                  name="shield-checkmark-outline"
                  size={20}
                  color={c.mintDim}
                />
              </View>
              <View style={styles.operationCopy}>
                <Text style={styles.operationLabel}>AFA collected</Text>
                <Text style={styles.operationHint}>
                  {count(afa.transaction_count)} registrations
                </Text>
              </View>
              <Text style={styles.operationValue}>
                {money(afa.net_collected)}
              </Text>
            </View>
          </View>

          <View style={styles.healthRow}>
            <View
              style={[styles.healthCard, { backgroundColor: `${c.amber}14` }]}
            >
              <Ionicons name="time-outline" size={22} color={c.amber} />
              <Text style={styles.healthValue}>
                {count(subAgentSales.held_count)}
              </Text>
              <Text style={styles.healthLabel}>Held orders</Text>
            </View>
            <View
              style={[styles.healthCard, { backgroundColor: `${c.rose}14` }]}
            >
              <Ionicons name="close-circle-outline" size={22} color={c.rose} />
              <Text style={styles.healthValue}>
                {count(
                  Number(subAgentSales.cancelled_count || 0) +
                    Number(ownPurchases.cancelled_count || 0),
                )}
              </Text>
              <Text style={styles.healthLabel}>Cancelled / failed</Text>
            </View>
          </View>

          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Top sub-agents</Text>
              <Text style={styles.sectionSubtitle}>
                By realized markup earnings
              </Text>
            </View>
          </View>
          {analytics.sub_agents?.length ? (
            analytics.sub_agents.slice(0, 8).map((agent, index) => (
              <View key={agent.agent_id || index} style={styles.agentRow}>
                <View style={styles.rank}>
                  <Text style={styles.rankText}>{index + 1}</Text>
                </View>
                <View style={styles.agentCopy}>
                  <Text style={styles.agentName}>
                    {agent.name || "Sub-agent"}
                  </Text>
                  <Text style={styles.agentMeta}>
                    {count(agent.transaction_count)} transactions ·{" "}
                    {money(agent.gross_sales)} sales
                  </Text>
                </View>
                <View style={styles.agentEarnings}>
                  <Text style={styles.agentEarningsValue}>
                    {money(agent.markup_earnings)}
                  </Text>
                  <Text style={styles.agentEarningsLabel}>markup</Text>
                </View>
              </View>
            ))
          ) : (
            <View style={styles.emptyCard}>
              <Ionicons name="people-outline" size={42} color={c.textMuted} />
              <Text style={styles.emptyTitle}>No sub-agent sales yet</Text>
              <Text style={styles.emptyText}>
                Assigned sub-agent transactions will populate this breakdown.
              </Text>
            </View>
          )}

          <Text style={styles.footnote}>
            Analytics use immutable payment snapshots and exclude cancelled or
            failed orders from active earnings.
          </Text>
        </ScrollView>
      )}
    </ThemedScreen>
  );
}

// Layered on the shared kit: `themedStyles(c)` already owns the surface, border
// and type ramp, so this file only adds the analytics-specific pieces and the
// handful of tones that are semantic here (earnings hero, status pills).
const useAnalyticsStyles = (c, topInset = 0) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    ...base,
    safeArea: { ...base.screen },
    header: { ...base.header, paddingVertical: 12, paddingTop: 8 + topInset },
    backButton: { ...base.backButton, borderRadius: 14 },
    refreshButton: { ...base.headerAction, borderRadius: 999 },
    eyebrow: { ...base.sectionEyebrow, marginBottom: 0 },
    title: { ...base.headerTitle, fontSize: 20 },
    centered: { ...base.center },
    loadingText: { ...base.headerSubtitle, marginTop: 12 },

    content: { ...base.body, paddingTop: 4, gap: 12 },

    // Earnings hero keeps a dark, luminous card in BOTH schemes - the number is
    // the headline of this screen and must not lose its contrast.
    heroCard: {
      padding: 20,
      borderRadius: 22,
      backgroundColor: c.heroTo,
      overflow: "hidden",
    },
    heroTopline: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    heroLabel: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.heroTextDim,
    },
    heroValue: {
      fontFamily: fonts.display,
      fontSize: 30,
      color: c.heroText,
      marginTop: 5,
    },
    heroIcon: {
      width: 52,
      height: 52,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255, 255, 255, 0.18)",
    },
    heroDescription: {
      fontFamily: fonts.body,
      fontSize: 12,
      lineHeight: 18,
      color: c.heroTextDim,
      marginTop: 14,
    },

    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 8,
      marginBottom: 2,
    },
    sectionTitle: { ...base.sectionTitle, fontSize: 17, marginBottom: 0 },
    sectionSubtitle: { ...base.headerSubtitle },

    periodGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    metricCard: {
      ...base.card,
      width: "48%",
      minHeight: 118,
      padding: 14,
      borderRadius: 18,
    },
    metricIcon: {
      width: 36,
      height: 36,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 10,
    },
    metricLabel: {
      ...base.rowSubtitle,
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      marginTop: 0,
    },
    metricValue: { fontFamily: fonts.bodyBold, fontSize: 16, marginTop: 4 },
    metricDetail: { ...base.rowSubtitle, fontSize: 10, marginTop: 3 },

    livePill: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: `${c.mint}1F`,
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 999,
    },
    liveDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: c.mint,
      marginRight: 5,
    },
    liveText: { fontFamily: fonts.bodyBold, fontSize: 9, color: c.mint },

    panel: { ...base.card, padding: 16, borderRadius: 20 },
    chart: { minHeight: 145, justifyContent: "center" },
    chartBars: {
      height: 130,
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 5,
    },
    barColumn: { flex: 1, alignItems: "center" },
    barTrack: {
      height: 108,
      width: "100%",
      justifyContent: "flex-end",
      alignItems: "center",
    },
    bar: {
      width: "72%",
      minWidth: 4,
      borderTopLeftRadius: 5,
      borderTopRightRadius: 5,
      backgroundColor: c.mintDim,
    },
    barLabel: {
      fontFamily: fonts.body,
      fontSize: 8,
      color: c.textMuted,
      marginTop: 5,
    },

    totalCard: { ...base.card, padding: 16, borderRadius: 20 },
    totalRow: { flexDirection: "row", alignItems: "center" },
    totalIcon: {
      ...base.rowIcon,
      borderRadius: 14,
      backgroundColor: c.surfaceHover,
    },
    totalCopy: { flex: 1, marginLeft: 11 },
    totalLabel: { ...base.rowTitle },
    totalHint: { ...base.rowSubtitle },
    totalValue: { fontFamily: fonts.bodyBold, fontSize: 20, color: c.mint },
    divider: { ...base.divider, marginVertical: 13 },

    breakdownGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    breakdownCard: {
      ...base.card,
      width: "48%",
      padding: 15,
      borderRadius: 18,
    },
    breakdownLabel: {
      ...base.rowSubtitle,
      fontFamily: fonts.bodySemi,
      fontSize: 11,
      marginTop: 0,
    },
    breakdownValue: {
      fontFamily: fonts.bodyBold,
      fontSize: 17,
      color: c.mint,
      marginTop: 6,
    },
    breakdownHint: { ...base.rowSubtitle, fontSize: 9, marginTop: 4 },

    operationsCard: { ...base.card, padding: 15, borderRadius: 20, gap: 14 },
    operationRow: { flexDirection: "row", alignItems: "center" },
    operationIcon: {
      width: 38,
      height: 38,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceHover,
    },
    operationCopy: { flex: 1, marginLeft: 10 },
    operationLabel: { ...base.rowTitle, fontSize: 13 },
    operationHint: { ...base.rowSubtitle, fontSize: 10, marginTop: 2 },
    operationValue: { ...base.rowValue, color: c.textPrimary },

    healthRow: { flexDirection: "row", gap: 10 },
    healthCard: { flex: 1, padding: 15, borderRadius: 18 },
    healthValue: {
      fontFamily: fonts.display,
      fontSize: 22,
      color: c.textPrimary,
      marginTop: 7,
    },
    healthLabel: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 2,
    },

    agentRow: {
      ...base.card,
      flexDirection: "row",
      alignItems: "center",
      padding: 13,
      borderRadius: 16,
    },
    rank: {
      width: 30,
      height: 30,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: `${c.mint}1F`,
    },
    rankText: { fontFamily: fonts.bodyBold, fontSize: 13, color: c.mint },
    agentCopy: { flex: 1, marginLeft: 10 },
    agentName: { ...base.rowTitle, fontSize: 13 },
    agentMeta: { ...base.rowSubtitle, fontSize: 10, marginTop: 3 },
    agentEarnings: { alignItems: "flex-end" },
    agentEarningsValue: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.textPrimary,
    },
    agentEarningsLabel: {
      fontFamily: fonts.body,
      fontSize: 9,
      color: c.textMuted,
      marginTop: 2,
    },

    emptyCard: {
      ...base.card,
      padding: 28,
      borderRadius: 20,
      alignItems: "center",
    },
    emptyTitle: { ...base.rowTitle, fontSize: 15, marginTop: 8 },
    emptyText: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      textAlign: "center",
      marginTop: 5,
    },
    footnote: {
      fontFamily: fonts.body,
      fontSize: 10,
      lineHeight: 15,
      color: c.textMuted,
      textAlign: "center",
      paddingHorizontal: 16,
      marginTop: 8,
    },
  });
};
