import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedScreen, themedStyles } from "../components/ui";
import { fonts } from "../components/theme";
import { useNotification } from "../contexts/NotificationContext";
import { useProfile } from "../contexts/ProfileContext";
import { useTheme } from "../contexts/ThemeContext";
import { getEdgeFunctionErrorMessage } from "../lib/edgeFunctions";
import { getEdgeFunctionName } from "../lib/env";
import { supabase } from "../lib/supabase";
import { buildPackageCards } from "../lib/superAgentPricing";
import { fetchAssignedSubAgents } from "../lib/superAgentRoster";
import { fetchCatalogPackages } from "../services/superAgentService";
import OffersPanel from "./SuperAgentOffersScreen";
import TiersPanel from "./SuperAgentTierManagementScreen";

const tabs = [
  { key: "offers", label: "Package offers", icon: "pricetags-outline" },
  { key: "tiers", label: "Tiers", icon: "layers-outline" },
];

const initialTab = (route) => {
  const requested = route.params?.tab;
  if (requested === "offers" || requested === "tiers") return requested;
  return route.name === "SuperAgentTierManagement" ? "tiers" : "offers";
};

const readPricing = async (name, action) => {
  const { data, error } = await supabase.functions.invoke(
    getEdgeFunctionName(name),
    { body: { action } },
  );
  if (error) throw new Error(await getEdgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return data;
};

export default function SuperAgentPricingScreen({ navigation, route }) {
  const { c } = useTheme();
  const { top } = useSafeAreaInsets();
  const { isSuperAgent, loading: profileLoading } = useProfile();
  const { showError } = useNotification();
  const [tab, setTab] = useState(() => initialTab(route));
  const [data, setData] = useState(null);
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [roster, setRoster] = useState(null);
  const [rosterRefresh, setRosterRefresh] = useState(0);
  const base = themedStyles(c);
  const requestedTab = route.params?.tab;
  const userId = data?.userId;

  useEffect(() => {
    if (requestedTab === "offers" || requestedTab === "tiers") {
      setTab(requestedTab);
    }
  }, [requestedTab]);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) {
        navigation.replace("Login");
        return;
      }
      const badge = String(user.app_metadata?.super_agent_badge || "enterprise").toLowerCase();
      if (!isSuperAgent || badge !== "enterprise") {
        if (isSuperAgent) {
          showError("Enterprise access", "Pricing is not included in the Pro badge.");
        }
        navigation.replace("Home");
        return;
      }

      const [offerData, tierData, pricingData, catalog] = await Promise.all([
        readPricing("super-agent-offers", "listSuperAgentOffers"),
        readPricing("super-agent-tier-management", "listTiers"),
        readPricing("super-agent-offers", "getPackageBasePrices"),
        fetchCatalogPackages(),
      ]);
      setOffers(offerData?.offers || []);
      setData({
        userId: user.id,
        tiers: tierData?.tiers || [],
        pricing: pricingData?.pricing || [],
        enabledProviders: pricingData?.providers ?? null,
        catalog,
      });
      if (!catalog.length && pricingData?.providers?.length !== 0) {
        setLoadError("The package catalog is unavailable. Refresh to try again.");
      }
    } catch (error) {
      console.error("Error loading pricing:", error);
      setLoadError("Unable to load the latest packages and tier prices. Refresh to try again.");
    } finally {
      setLoading(false);
    }
  }, [isSuperAgent, navigation, showError]);

  useEffect(() => {
    if (!profileLoading) void reload();
  }, [profileLoading, reload]);

  useFocusEffect(useCallback(() => {
    if (tab !== "tiers" || !userId) return;
    let current = true;
    setRoster({ userId, status: "loading", agents: [] });
    fetchAssignedSubAgents(userId).then((agents) => {
      if (current) setRoster({ userId, status: "ready", agents });
    }).catch((error) => {
      console.warn("Could not load tier assignments:", error.message);
      if (current) setRoster({ userId, status: "error", agents: [] });
    });
    return () => { current = false; };
  }, [tab, userId, rosterRefresh]));

  const refresh = async () => {
    if (loading || refreshing || mutating) return;
    setRefreshing(true);
    if (tab === "tiers") setRosterRefresh((value) => value + 1);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  const cards = useMemo(
    () => data ? buildPackageCards(data.catalog, data.pricing, offers, data.enabledProviders) : [],
    [data, offers],
  );
  const setTiers = (update) => {
    setData((current) => current ? { ...current, tiers: update(current.tiers) } : current);
  };
  const panelProps = {
    cards,
    userId,
    tiers: data?.tiers,
    setTiers,
    setOffers,
    onRefresh: refresh,
    refreshing,
    setMutating,
  };

  return (
    <ThemedScreen>
      <View style={[base.header, { paddingTop: 18 + (Platform.OS === "android" ? top : 0), paddingBottom: 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={base.backButton} accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={24} color={c.textPrimary} />
        </TouchableOpacity>
        <Text style={[base.headerTitle, styles.title]}>Pricing</Text>
        <TouchableOpacity
          onPress={refresh}
          style={base.backButton}
          disabled={loading || refreshing || mutating}
          accessibilityLabel="Refresh pricing"
        >
          <Ionicons name="sync-outline" size={20} color={loading || refreshing || mutating ? c.textMuted : c.mint} />
        </TouchableOpacity>
      </View>

      <View style={[styles.tabs, { backgroundColor: c.surface, borderColor: c.hairline }]} accessibilityRole="tablist">
        {tabs.map(({ key, label, icon }) => {
          const selected = tab === key;
          const color = selected ? c.onAccent : c.textSecondary;
          return (
            <TouchableOpacity
              key={key}
              onPress={() => {
                Keyboard.dismiss();
                setTab(key);
              }}
              disabled={mutating}
              accessibilityRole="tab"
              accessibilityState={{ selected, disabled: mutating }}
              style={[styles.tab, selected && { backgroundColor: c.mint }]}
            >
              <Ionicons name={icon} size={17} color={color} />
              <Text style={[styles.tabLabel, { color }]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loadError ? (
        <Text style={[styles.error, { color: c.rose, backgroundColor: `${c.rose}14` }]} accessibilityLiveRegion="polite">
          {loadError}
        </Text>
      ) : null}

      {loading || refreshing && !data ? (
        <View style={base.center}><ActivityIndicator size="large" color={c.mint} /></View>
      ) : data ? (
        <>
          <View style={tab === "offers" ? styles.panel : styles.hidden}><OffersPanel {...panelProps} /></View>
          <View style={tab === "tiers" ? styles.panel : styles.hidden}>
            <TiersPanel {...panelProps} roster={roster?.userId === userId ? roster : null} />
          </View>
        </>
      ) : null}
    </ThemedScreen>
  );
}

const styles = StyleSheet.create({
  title: { flex: 1, fontSize: 20, textAlign: "center" },
  tabs: {
    flexDirection: "row",
    gap: 5,
    padding: 4,
    borderWidth: 1,
    borderRadius: 15,
    marginHorizontal: 20,
  },
  tab: {
    flex: 1,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 6,
    borderRadius: 11,
  },
  tabLabel: { fontFamily: fonts.bodyBold, fontSize: 13 },
  panel: { flex: 1 },
  hidden: { display: "none" },
  error: { marginHorizontal: 20, marginTop: 10, borderRadius: 12, padding: 12, fontFamily: fonts.body },
});
