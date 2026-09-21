import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import { getEdgeFunctionName } from "../lib/env";
import colors from "../components/theme";

const packageKey = (network, type) =>
  `${String(network || "").toUpperCase()}::${String(type || "").toUpperCase()}`;

const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

export default function SuperAgentOffersScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offers, setOffers] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [packages, setPackages] = useState([]);
  const [basePriceMap, setBasePriceMap] = useState({});
  const [priceInputs, setPriceInputs] = useState({});
  const [savingOfferId, setSavingOfferId] = useState(null);
  const [togglingOfferId, setTogglingOfferId] = useState(null);
  const [confirmDeleteOfferId, setConfirmDeleteOfferId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // New offer form
  const [formNetwork, setFormNetwork] = useState("");
  const [formPackageKey, setFormPackageKey] = useState("");
  const [formTierName, setFormTierName] = useState("");
  const [formPrice, setFormPrice] = useState("");
  const [creatingOffer, setCreatingOffer] = useState(false);

  const { showError, showSuccess, showInfo } = useNotification();

  const loadData = useCallback(
    async ({ showSpinner = true } = {}) => {
      if (showSpinner) setLoading(true);
      setLoadError(null);

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

        const [offersResult, tiersResult, packagesResult, pricingResult] =
          await Promise.all([
            supabase.functions.invoke(
              getEdgeFunctionName("super-agent-offers"),
              { body: { action: "listSuperAgentOffers" } },
            ),
            supabase.functions.invoke(
              getEdgeFunctionName("super-agent-tier-management"),
              { body: { action: "listTiers" } },
            ),
            supabase.functions.invoke(getEdgeFunctionName("get-packages")),
            supabase.functions.invoke(
              getEdgeFunctionName("super-agent-offers"),
              { body: { action: "getPackageBasePrices" } },
            ),
          ]);

        if (offersResult.error) {
          console.error("Error loading offers:", offersResult.error);
        }
        if (tiersResult.error) {
          console.error("Error loading tiers:", tiersResult.error);
        }
        if (packagesResult.error) {
          console.error("Error loading packages:", packagesResult.error);
        }
        if (pricingResult.error) {
          console.error("Error loading base prices:", pricingResult.error);
        }

        const offerRows = offersResult.data?.offers || [];
        const tierRows = tiersResult.data?.tiers || [];
        const catalog = packagesResult.data?.payload || [];
        const pricingRows = pricingResult.data?.pricing || [];

        setOffers(offerRows);
        setTiers(tierRows);
        setPackages(Array.isArray(catalog) ? catalog : []);

        if (!Array.isArray(catalog) || catalog.length === 0) {
          setLoadError(
            "Could not load the data bundle catalog. Pull down to retry.",
          );
        }

        const basePrices = {};
        (pricingRows || []).forEach((row) => {
          basePrices[packageKey(row.network, row.type)] = Number(row.base_price);
        });
        setBasePriceMap(basePrices);

        // Keep any in-progress edits that match loaded offers
        setPriceInputs((prev) => {
          const next = {};
          offerRows.forEach((offer) => {
            next[offer.id] =
              prev[offer.id] !== undefined
                ? prev[offer.id]
                : String(offer.price);
          });
          return next;
        });

        setFormNetwork((prevNetwork) => {
          if (prevNetwork) return prevNetwork;
          const first = (Array.isArray(catalog) ? catalog : [])[0];
          return first ? String(first.network || "").toUpperCase() : "";
        });
      } catch (error) {
        console.error("Error loading super agent offers screen:", error);
        setLoadError("Unable to load your offers right now.");
        showError("Error", "Unable to load your offers right now.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [navigation, showError],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData({ showSpinner: false });
  };

  const packageMap = useMemo(() => {
    const map = {};
    (packages || []).forEach((pkg) => {
      map[packageKey(pkg.network, pkg.type)] = pkg;
    });
    return map;
  }, [packages]);

  const networkOptions = useMemo(() => {
    const networks = [];
    (packages || []).forEach((pkg) => {
      const value = String(pkg.network || "").toUpperCase();
      if (value && !networks.includes(value)) networks.push(value);
    });
    return networks;
  }, [packages]);

  const formPackages = useMemo(
    () =>
      (packages || []).filter(
        (pkg) =>
          String(pkg.network || "").toUpperCase() ===
          String(formNetwork || "").toUpperCase(),
      ),
    [packages, formNetwork],
  );

  const offerGroups = useMemo(() => {
    const byName = {};
    (offers || []).forEach((offer) => {
      const name = offer.tier_name || "";
      if (!byName[name]) byName[name] = [];
      byName[name].push(offer);
    });

    const ordered = [];
    (tiers || []).forEach((tier) => {
      if (byName[tier.name]) {
        ordered.push({ title: tier.name, items: byName[tier.name] });
        delete byName[tier.name];
      }
    });
    Object.keys(byName).forEach((name) => {
      ordered.push({ title: name || "General", items: byName[name] });
    });

    return ordered;
  }, [offers, tiers]);

  const handlePriceChange = (offerId, text) => {
    const cleaned = text.replace(/[^0-9.]/g, "");
    const parts = cleaned.split(".");
    const normalized =
      parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : cleaned;
    setPriceInputs((prev) => ({ ...prev, [offerId]: normalized }));
  };

  const handleSavePrice = async (offer) => {
    const raw = (priceInputs[offer.id] ?? "").toString().trim();
    const value = Number(raw);

    if (raw === "" || !Number.isFinite(value) || value <= 0) {
      showError("Validation", "Enter an amount greater than 0.");
      return;
    }

    if (Math.abs(Number(offer.price) - value) <= 0.0001) {
      showInfo("Nothing to save", "This price is already up to date.");
      return;
    }

    try {
      setSavingOfferId(offer.id);

      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-offers"),
        {
          body: {
            action: "updateOffer",
            offer: { id: offer.id, price: value },
          },
        },
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      showSuccess("Price updated", `${offer.title} now costs ${formatGhc(value)}.`);
      await loadData({ showSpinner: false });
    } catch (priceError) {
      console.error("Error updating offer price:", priceError);
      showError("Error", "Unable to update this price right now.");
    } finally {
      setSavingOfferId(null);
    }
  };

  const handleToggleActive = async (offer) => {
    try {
      setTogglingOfferId(offer.id);

      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-offers"),
        {
          body: {
            action: "updateOffer",
            offer: { id: offer.id, is_active: !offer.is_active },
          },
        },
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      showSuccess(
        !offer.is_active ? "Offer activated" : "Offer paused",
        `${offer.title} is now ${!offer.is_active ? "active" : "inactive"}.`,
      );
      await loadData({ showSpinner: false });
    } catch (toggleError) {
      console.error("Error toggling offer:", toggleError);
      showError("Error", "Unable to update this offer right now.");
    } finally {
      setTogglingOfferId(null);
    }
  };

  const handleDeleteOffer = async (offer) => {
    if (confirmDeleteOfferId !== offer.id) {
      setConfirmDeleteOfferId(offer.id);
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-offers"),
        { body: { action: "deleteOffer", offer: { id: offer.id } } },
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      showSuccess("Offer deleted", `${offer.title} was removed.`);
      setConfirmDeleteOfferId(null);
      await loadData({ showSpinner: false });
    } catch (deleteError) {
      console.error("Error deleting offer:", deleteError);
      showError("Error", "Unable to delete this offer right now.");
      setConfirmDeleteOfferId(null);
    }
  };

  const handleCreateOffer = async () => {
    const selectedPkg = packageMap[formPackageKey];
    if (!selectedPkg) {
      showError("Validation", "Choose a data bundle for this offer.");
      return;
    }

    const value = Number((formPrice || "").trim());
    if (!Number.isFinite(value) || value <= 0) {
      showError("Validation", "Enter an amount greater than 0.");
      return;
    }

    try {
      setCreatingOffer(true);

      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-offers"),
        {
          body: {
            action: "upsertTierOffer",
            offer: {
              network: selectedPkg.network,
              data_value: selectedPkg.type,
              tier_name: formTierName || null,
              price: value,
            },
          },
        },
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      showSuccess(
        "Offer saved",
        `${selectedPkg.network} — ${selectedPkg.type} is priced at ${formatGhc(value)}.`,
      );
      setFormPackageKey("");
      setFormPrice("");
      await loadData({ showSpinner: false });
    } catch (createError) {
      console.error("Error creating offer:", createError);
      showError("Error", "Unable to save this offer right now.");
    } finally {
      setCreatingOffer(false);
    }
  };

  const renderOfferRow = (offer) => {
    const pkg = packageMap[packageKey(offer.network, offer.data_value)];
    const basePrice = basePriceMap[packageKey(offer.network, offer.data_value)];
    const isSaving = savingOfferId === offer.id;
    const isToggling = togglingOfferId === offer.id;
    const isConfirmingDelete = confirmDeleteOfferId === offer.id;

    return (
      <View
        key={`offer-${offer.id}`}
        style={[styles.offerRow, !offer.is_active && styles.offerRowInactive]}
      >
        <View style={styles.offerInfo}>
          <View style={styles.offerTitleRow}>
            <Text style={styles.offerTitle}>{offer.title}</Text>
            <View style={styles.networkBadge}>
              <Text style={styles.networkBadgeText}>
                {String(offer.network || "").toUpperCase()}
              </Text>
            </View>
          </View>
          <Text style={styles.offerMeta}>
            {String(offer.data_value || "").toUpperCase()}
            {pkg?.size ? ` · ${pkg.size} GB` : ""}
            {basePrice !== undefined
              ? ` · Admin base: ${formatGhc(basePrice)}`
              : ""}
          </Text>
          <Text style={styles.offerStatus}>
            {offer.is_active ? "Active" : "Inactive — hidden from agents"}
          </Text>
        </View>

        <View style={styles.offerControls}>
          <View style={styles.priceInputWrap}>
            <Text style={styles.currencyPrefix}>Ghc</Text>
            <TextInput
              style={styles.priceInput}
              value={priceInputs[offer.id] ?? String(offer.price)}
              onChangeText={(text) => handlePriceChange(offer.id, text)}
              keyboardType="decimal-pad"
            />
          </View>
          <View style={styles.offerActions}>
            <TouchableOpacity
              style={[
                styles.actionChip,
                styles.actionChipSave,
                (isSaving || isToggling) && styles.actionChipDisabled,
              ]}
              onPress={() => handleSavePrice(offer)}
              disabled={isSaving || isToggling}
            >
              {isSaving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="checkmark" size={16} color="#fff" />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionChip,
                offer.is_active ? styles.actionChipPause : styles.actionChipPlay,
                (isSaving || isToggling) && styles.actionChipDisabled,
              ]}
              onPress={() => handleToggleActive(offer)}
              disabled={isSaving || isToggling}
            >
              <Ionicons
                name={offer.is_active ? "pause" : "play"}
                size={14}
                color="#fff"
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionChip,
                isConfirmingDelete
                  ? styles.actionChipDeleteConfirm
                  : styles.actionChipDelete,
              ]}
              onPress={() => handleDeleteOffer(offer)}
            >
              <Ionicons
                name={isConfirmingDelete ? "warning" : "trash-outline"}
                size={14}
                color="#fff"
              />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading offers...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>Offers</Text>
        <TouchableOpacity
          onPress={handleRefresh}
          style={styles.refreshButton}
          disabled={refreshing}
        >
          <Ionicons
            name={refreshing ? "sync" : "sync-outline"}
            size={20}
            color={refreshing ? colors.border : colors.primary}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={20} color={colors.primary} />
          <Text style={styles.infoText}>
            These are the prices your sub-agents pay. Group them by tier or
            leave them general. Manage tier pricing per bundle in Tier
            Management.
          </Text>
        </View>

        {loadError ? (
          <View style={styles.errorCard}>
            <Ionicons name="warning-outline" size={18} color={colors.danger} />
            <Text style={styles.errorText}>{loadError}</Text>
          </View>
        ) : null}

        <View style={styles.createCard}>
          <Text style={styles.createTitle}>New Offer</Text>

          <Text style={styles.fieldLabel}>Network</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {networkOptions.map((option) => (
              <TouchableOpacity
                key={option}
                style={[
                  styles.chip,
                  formNetwork === option && styles.chipActive,
                ]}
                onPress={() => {
                  setFormNetwork(option);
                  setFormPackageKey("");
                }}
              >
                <Text
                  style={[
                    styles.chipText,
                    formNetwork === option && styles.chipTextActive,
                  ]}
                >
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {formNetwork ? (
            <>
              <Text style={styles.fieldLabel}>Bundle</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                {formPackages.map((pkg) => {
                  const key = packageKey(pkg.network, pkg.type);
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[
                        styles.chip,
                        formPackageKey === key && styles.chipActive,
                      ]}
                      onPress={() => setFormPackageKey(key)}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          formPackageKey === key && styles.chipTextActive,
                        ]}
                      >
                        {String(pkg.type || "").toUpperCase()}
                        {pkg.size ? ` · ${pkg.size}GB` : ""}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          ) : null}

          <Text style={styles.fieldLabel}>Tier</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            <TouchableOpacity
              style={[styles.chip, !formTierName && styles.chipActive]}
              onPress={() => setFormTierName("")}
            >
              <Text
                style={[
                  styles.chipText,
                  !formTierName && styles.chipTextActive,
                ]}
              >
                General
              </Text>
            </TouchableOpacity>
            {(tiers || []).map((tier) => (
              <TouchableOpacity
                key={`tier-${tier.id}`}
                style={[
                  styles.chip,
                  formTierName === tier.name && styles.chipActive,
                ]}
                onPress={() => setFormTierName(tier.name)}
              >
                <Text
                  style={[
                    styles.chipText,
                    formTierName === tier.name && styles.chipTextActive,
                  ]}
                >
                  {tier.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <View style={styles.createPriceRow}>
            <View style={styles.priceInputWrap}>
              <Text style={styles.currencyPrefix}>Ghc</Text>
              <TextInput
                style={styles.priceInput}
                value={formPrice}
                onChangeText={(text) => {
                  const cleaned = text.replace(/[^0-9.]/g, "");
                  const parts = cleaned.split(".");
                  setFormPrice(
                    parts.length > 2
                      ? `${parts[0]}.${parts.slice(1).join("")}`
                      : cleaned,
                  );
                }}
                placeholder="0.00"
                placeholderTextColor="#9AA5AF"
                keyboardType="decimal-pad"
              />
            </View>
            <TouchableOpacity
              style={[
                styles.createButton,
                creatingOffer && styles.createButtonDisabled,
              ]}
              onPress={handleCreateOffer}
              disabled={creatingOffer}
            >
              {creatingOffer ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="add-circle-outline" size={18} color="#fff" />
                  <Text style={styles.createButtonText}>Save Offer</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {offerGroups.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="pricetags-outline" size={40} color={colors.primary} />
            <Text style={styles.emptyTitle}>No offers yet</Text>
            <Text style={styles.emptyText}>
              Create your first offer above, or set prices for every bundle in
              a tier from Tier Management.
            </Text>
          </View>
        ) : (
          offerGroups.map((group) => (
            <View key={`group-${group.title}`} style={styles.groupCard}>
              <View style={styles.groupHeader}>
                <Ionicons name="layers" size={16} color={colors.primary} />
                <Text style={styles.groupTitle}>
                  {group.title} ({group.items.length})
                </Text>
              </View>
              {group.items.map(renderOfferRow)}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
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
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 20,
    fontWeight: "800",
    color: colors.dark,
  },
  refreshButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  infoCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.tint,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  infoText: {
    flex: 1,
    marginLeft: 10,
    color: colors.dark,
    fontSize: 13,
    lineHeight: 19,
  },
  errorCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fdecea",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  errorText: {
    flex: 1,
    marginLeft: 10,
    color: colors.danger,
    fontSize: 13,
    fontWeight: "500",
  },
  createCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
  },
  createTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: colors.primary,
    marginBottom: 10,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.dark,
    opacity: 0.7,
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 2,
    marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.light,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: 8,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.dark,
  },
  chipTextActive: {
    color: "#fff",
  },
  createPriceRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
  },
  createButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 12,
    marginLeft: 10,
  },
  createButtonDisabled: {
    opacity: 0.6,
  },
  createButtonText: {
    color: "#fff",
    fontWeight: "700",
    marginLeft: 6,
  },
  groupCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  groupTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: colors.primary,
    marginLeft: 8,
  },
  offerRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.light,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  offerRowInactive: {
    opacity: 0.65,
  },
  offerInfo: {
    flex: 1,
    marginRight: 8,
  },
  offerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  offerTitle: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "700",
    color: colors.dark,
    marginRight: 6,
  },
  networkBadge: {
    backgroundColor: colors.primary,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  networkBadgeText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "800",
  },
  offerMeta: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.65,
    marginTop: 3,
  },
  offerStatus: {
    fontSize: 10,
    color: colors.dark,
    opacity: 0.5,
    marginTop: 2,
  },
  offerControls: {
    alignItems: "flex-end",
  },
  priceInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 8,
    height: 34,
    width: 104,
  },
  currencyPrefix: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.6,
    marginRight: 4,
    fontWeight: "600",
  },
  priceInput: {
    flex: 1,
    fontSize: 13,
    color: colors.dark,
    paddingVertical: 0,
    fontWeight: "700",
  },
  offerActions: {
    flexDirection: "row",
    marginTop: 6,
  },
  actionChip: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 6,
  },
  actionChipSave: {
    backgroundColor: colors.success,
  },
  actionChipPause: {
    backgroundColor: colors.warning,
  },
  actionChipPlay: {
    backgroundColor: colors.accent,
  },
  actionChipDelete: {
    backgroundColor: colors.border,
  },
  actionChipDeleteConfirm: {
    backgroundColor: colors.danger,
  },
  actionChipDisabled: {
    opacity: 0.6,
  },
  emptyCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: 24,
    alignItems: "center",
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: colors.primary,
    marginTop: 10,
  },
  emptyText: {
    fontSize: 13,
    color: colors.dark,
    opacity: 0.7,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 20,
  },
});
