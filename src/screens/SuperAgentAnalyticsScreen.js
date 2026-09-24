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
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import colors from "../components/theme";

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
    <View style={styles.chart}>
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
    </View>
  );
};

const MetricCard = ({ icon, label, value, detail, tone = colors.primary }) => (
  <View style={styles.metricCard}>
    <View style={[styles.metricIcon, { backgroundColor: `${tone}18` }]}>
      <Ionicons name={icon} size={21} color={tone} />
    </View>
    <Text style={styles.metricLabel}>{label}</Text>
    <Text style={[styles.metricValue, { color: tone }]}>{value}</Text>
    {detail ? <Text style={styles.metricDetail}>{detail}</Text> : null}
  </View>
);

export default function SuperAgentAnalyticsScreen({ navigation }) {
  const { showError } = useNotification();
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
    <SafeAreaView
      style={styles.safeArea}
      edges={["top", "right", "bottom", "left"]}
    >
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
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
          <Ionicons name="refresh" size={21} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Calculating your business...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadAnalytics(true)}
              tintColor={colors.primary}
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
                <Ionicons name="trending-up" size={26} color={colors.white} />
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
            <Ionicons name="analytics" size={22} color={colors.primary} />
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
                <Ionicons
                  name="git-network-outline"
                  size={22}
                  color={colors.primary}
                />
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
                  color={colors.secondary}
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
                <Ionicons name="layers-outline" size={22} color="#7C3AED" />
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
              <Text
                style={[styles.breakdownValue, { color: colors.secondary }]}
              >
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
                <Ionicons
                  name="wallet-outline"
                  size={20}
                  color={colors.primary}
                />
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
                <Ionicons
                  name="cash-outline"
                  size={20}
                  color={colors.secondary}
                />
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
                <Ionicons name="card-outline" size={20} color="#D97706" />
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
                  color="#7C3AED"
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
            <View style={[styles.healthCard, { backgroundColor: "#FFF7E8" }]}>
              <Ionicons name="time-outline" size={22} color={colors.warning} />
              <Text style={styles.healthValue}>
                {count(subAgentSales.held_count)}
              </Text>
              <Text style={styles.healthLabel}>Held orders</Text>
            </View>
            <View style={[styles.healthCard, { backgroundColor: "#FDEDEC" }]}>
              <Ionicons
                name="close-circle-outline"
                size={22}
                color={colors.danger}
              />
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
              <Ionicons name="people-outline" size={42} color={colors.border} />
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.light },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.tint,
  },
  headerCopy: { flex: 1, marginLeft: 12 },
  eyebrow: {
    color: colors.secondary,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.4,
  },
  title: { color: colors.dark, fontSize: 20, fontWeight: "900" },
  refreshButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { marginTop: 12, color: colors.secondary },
  content: { padding: 16, paddingBottom: 36, gap: 12 },
  heroCard: {
    padding: 20,
    borderRadius: 22,
    backgroundColor: colors.dark,
    overflow: "hidden",
  },
  heroTopline: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  heroLabel: { color: "#A7B6BE", fontSize: 13, fontWeight: "600" },
  heroValue: {
    color: colors.white,
    fontSize: 30,
    fontWeight: "900",
    marginTop: 5,
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.secondary,
  },
  heroDescription: {
    color: "#C6D0D5",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 14,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 2,
  },
  sectionTitle: {
    color: colors.dark,
    fontSize: 17,
    fontWeight: "900",
  },
  sectionSubtitle: { color: colors.secondary, fontSize: 12, marginTop: 2 },
  periodGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  metricCard: {
    width: "48%",
    minHeight: 118,
    padding: 14,
    borderRadius: 18,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: "#E1E8EC",
  },
  metricIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  metricLabel: { color: colors.secondary, fontSize: 12, fontWeight: "600" },
  metricValue: { fontSize: 16, fontWeight: "900", marginTop: 4 },
  metricDetail: { color: colors.secondary, fontSize: 10, marginTop: 3 },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E8F7EE",
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 20,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
    marginRight: 5,
  },
  liveText: { color: colors.success, fontSize: 9, fontWeight: "900" },
  panel: {
    padding: 16,
    borderRadius: 20,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: "#E1E8EC",
  },
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
    backgroundColor: colors.secondary,
  },
  barLabel: { color: colors.secondary, fontSize: 8, marginTop: 5 },
  totalCard: {
    padding: 16,
    borderRadius: 20,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: "#E1E8EC",
  },
  totalRow: { flexDirection: "row", alignItems: "center" },
  totalIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.tint,
  },
  totalCopy: { flex: 1, marginLeft: 11 },
  totalLabel: { color: colors.dark, fontSize: 14, fontWeight: "800" },
  totalHint: { color: colors.secondary, fontSize: 11, marginTop: 3 },
  totalValue: { color: colors.primary, fontSize: 20, fontWeight: "900" },
  divider: { height: 1, backgroundColor: "#E6EBEE", marginVertical: 13 },
  breakdownGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  breakdownCard: {
    width: "48%",
    padding: 15,
    borderRadius: 18,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: "#E1E8EC",
  },
  breakdownLabel: { color: colors.secondary, fontSize: 11, fontWeight: "700" },
  breakdownValue: {
    color: colors.primary,
    fontSize: 17,
    fontWeight: "900",
    marginTop: 6,
  },
  breakdownHint: { color: colors.secondary, fontSize: 9, marginTop: 4 },
  operationsCard: {
    padding: 15,
    borderRadius: 20,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: "#E1E8EC",
    gap: 14,
  },
  operationRow: { flexDirection: "row", alignItems: "center" },
  operationIcon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.tint,
  },
  operationCopy: { flex: 1, marginLeft: 10 },
  operationLabel: { color: colors.dark, fontSize: 13, fontWeight: "800" },
  operationHint: { color: colors.secondary, fontSize: 10, marginTop: 2 },
  operationValue: { color: colors.dark, fontSize: 14, fontWeight: "900" },
  healthRow: { flexDirection: "row", gap: 10 },
  healthCard: { flex: 1, padding: 15, borderRadius: 18 },
  healthValue: {
    color: colors.dark,
    fontSize: 22,
    fontWeight: "900",
    marginTop: 7,
  },
  healthLabel: { color: colors.secondary, fontSize: 11, marginTop: 2 },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 13,
    borderRadius: 16,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: "#E1E8EC",
  },
  rank: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.tint,
  },
  rankText: { color: colors.primary, fontWeight: "900" },
  agentCopy: { flex: 1, marginLeft: 10 },
  agentName: { color: colors.dark, fontSize: 13, fontWeight: "800" },
  agentMeta: { color: colors.secondary, fontSize: 10, marginTop: 3 },
  agentEarnings: { alignItems: "flex-end" },
  agentEarningsValue: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: "900",
  },
  agentEarningsLabel: { color: colors.secondary, fontSize: 9, marginTop: 2 },
  emptyCard: {
    padding: 28,
    borderRadius: 20,
    alignItems: "center",
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: "#E1E8EC",
  },
  emptyTitle: {
    color: colors.dark,
    fontSize: 15,
    fontWeight: "800",
    marginTop: 8,
  },
  emptyText: {
    color: colors.secondary,
    fontSize: 11,
    textAlign: "center",
    marginTop: 5,
  },
  footnote: {
    color: colors.secondary,
    fontSize: 10,
    lineHeight: 15,
    textAlign: "center",
    paddingHorizontal: 16,
    marginTop: 8,
  },
});
