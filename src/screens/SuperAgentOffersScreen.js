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
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import { getEdgeFunctionName } from "../lib/env";
import { fonts } from "../components/theme";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";
import {
  upsertTierOffer,
  updateSuperAgentOffer,
  deleteSuperAgentOffer,
  fetchCatalogPackages,
} from "../services/superAgentService";

const getPackageDescriptor = (pkg) => {
  if (!pkg) return "";
  const type = String(pkg.type || "").trim();
  const size =
    pkg.size !== undefined &&
    pkg.size !== null &&
    String(pkg.size).trim() !== ""
      ? `${pkg.size}GB`
      : "";
  if (size && !type.toUpperCase().includes(size.toUpperCase())) {
    return `${type} - ${size}`;
  }
  return type || size || "DEFAULT";
};

const getPackageKey = (pkg) => {
  if (!pkg) return "";
  if (typeof pkg === "string") return pkg;
  if (pkg.id) return String(pkg.id);
  const net = String(pkg.network || "").toUpperCase();
  const desc = getPackageDescriptor(pkg).toUpperCase();
  return `${net}::${desc}`;
};

const findPricingRowForPackage = (rows, pkg) => {
  if (!rows || !pkg) return null;
  const net = String(pkg.network || "").toUpperCase();
  const desc = getPackageDescriptor(pkg).toUpperCase();
  const type = String(pkg.type || "").toUpperCase();
  const sizeStr =
    pkg.size !== undefined &&
    pkg.size !== null &&
    String(pkg.size).trim() !== ""
      ? `${pkg.size}GB`.toUpperCase()
      : "";

  return (
    rows.find((row) => {
      if (String(row.network || "").toUpperCase() !== net) return false;
      const rowType = String(row.type || "")
        .trim()
        .toUpperCase();
      if (pkg.id && rowType === String(pkg.id).trim().toUpperCase())
        return true;
      if (rowType === desc) return true;
      if (
        sizeStr &&
        (rowType === `${type} - ${sizeStr}` ||
          rowType === `${type} (${sizeStr})` ||
          rowType === `${type} ${sizeStr}` ||
          rowType === `${type}-${sizeStr}`)
      ) {
        return true;
      }
      return false;
    }) || null
  );
};

const packageKey = (network, type) =>
  `${String(network || "").toUpperCase()}::${String(type || "").toUpperCase()}`;

const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

const formatPriceInput = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
};

// Admin base prices are the default an offer price starts from. A base price of
// 0 counts as "not set" because offer prices must be greater than 0.
const usableBasePrice = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

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
  const theme = useTheme();
  const c = theme.c;
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useOfferStyles(c, topInset);

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
        const badge = String(
          user.user_metadata?.super_agent_badge ||
            user.app_metadata?.super_agent_badge ||
            "enterprise",
        ).toLowerCase();
        if (badge !== "enterprise") {
          showError(
            "Enterprise access",
            "Offer Management is not included in the Pro badge.",
          );
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
        let catalog = packagesResult.data?.payload || [];
        if (!Array.isArray(catalog) || catalog.length === 0) {
          catalog = await fetchCatalogPackages();
        }
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
        (catalog || []).forEach((pkg) => {
          const row = findPricingRowForPackage(pricingRows, pkg);
          if (row) {
            basePrices[getPackageKey(pkg)] = Number(row.base_price);
          }
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

  // Default the new-offer price to the admin base price of the chosen bundle.
  useEffect(() => {
    if (!formPackageKey) return;
    const basePrice = usableBasePrice(basePriceMap[formPackageKey]);
    setFormPrice(basePrice !== null ? formatPriceInput(basePrice) : "");
  }, [formPackageKey, basePriceMap]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData({ showSpinner: false });
  };

  const packageMap = useMemo(() => {
    const map = {};
    (packages || []).forEach((pkg) => {
      map[getPackageKey(pkg)] = pkg;
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

      await updateSuperAgentOffer({
        offerId: offer.id,
        updates: { price: value },
      });

      showSuccess(
        "Price updated",
        `${offer.title} now costs ${formatGhc(value)}.`,
      );
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

      await updateSuperAgentOffer({
        offerId: offer.id,
        updates: { is_active: !offer.is_active },
      });

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
      await deleteSuperAgentOffer(offer.id);

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

    // An empty amount falls back to the admin base price when one is set.
    const rawPrice = (formPrice || "").trim();
    const fallbackBasePrice = usableBasePrice(basePriceMap[formPackageKey]);
    const value =
      rawPrice !== ""
        ? Number(rawPrice)
        : fallbackBasePrice !== null
          ? fallbackBasePrice
          : NaN;

    if (!Number.isFinite(value) || value <= 0) {
      showError("Validation", "Enter an amount greater than 0.");
      return;
    }

    const desc = getPackageDescriptor(selectedPkg);

    try {
      setCreatingOffer(true);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      await upsertTierOffer({
        superAgentId: user?.id,
        offer: {
          network: selectedPkg.network,
          data_value: desc,
          title: `${selectedPkg.network} — ${desc}`,
          tier_name: formTierName || null,
          price: value,
        },
      });

      showSuccess(
        "Offer saved",
        `${selectedPkg.network} — ${desc} is priced at ${formatGhc(value)}.`,
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
    const offerNet = String(offer.network || "").toUpperCase();
    const offerVal = String(offer.data_value || "")
      .trim()
      .toUpperCase();

    const pkg =
      (packages || []).find((p) => {
        if (String(p.network || "").toUpperCase() !== offerNet) return false;
        const desc = getPackageDescriptor(p).toUpperCase();
        return (
          desc === offerVal ||
          String(p.type || "").toUpperCase() === offerVal ||
          (p.id && String(p.id).toUpperCase() === offerVal)
        );
      }) || packageMap[offer.data_value];

    const basePrice = pkg
      ? basePriceMap[getPackageKey(pkg)]
      : basePriceMap[offer.data_value];

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
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Ionicons name="checkmark" size={16} color={c.onAccent} />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionChip,
                offer.is_active
                  ? styles.actionChipPause
                  : styles.actionChipPlay,
                (isSaving || isToggling) && styles.actionChipDisabled,
              ]}
              onPress={() => handleToggleActive(offer)}
              disabled={isSaving || isToggling}
            >
              <Ionicons
                name={offer.is_active ? "pause" : "play"}
                size={14}
                color={c.onAccent}
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
                color={c.onAccent}
              />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <ThemedScreen style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={c.mint} />
          <Text style={styles.loadingText}>Loading offers...</Text>
        </View>
      </ThemedScreen>
    );
  }

  return (
    <ThemedScreen style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={c.textPrimary} />
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
            color={refreshing ? c.textMuted : c.mint}
          />
        </TouchableOpacity>
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={20} color={c.mint} />
          <Text style={styles.infoText}>
            These are the prices your sub-agents pay. New offers start at the
            admin base price for the bundle — change it to set your own margin.
            Group offers by tier or leave them general.
          </Text>
        </View>

        {loadError ? (
          <View style={styles.errorCard}>
            <Ionicons name="warning-outline" size={18} color={c.rose} />
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
                  setFormPrice("");
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
                  const key = getPackageKey(pkg);
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
                placeholderTextColor={c.textMuted}
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
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <>
                  <Ionicons
                    name="add-circle-outline"
                    size={18}
                    color={c.onAccent}
                  />
                  <Text style={styles.createButtonText}>Save Offer</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {formPackageKey &&
          usableBasePrice(basePriceMap[formPackageKey]) !== null ? (
            <Text style={styles.basePriceHint}>
              Admin base: {formatGhc(basePriceMap[formPackageKey])} — used by
              default
            </Text>
          ) : null}
        </View>

        {offerGroups.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="pricetags-outline" size={40} color={c.textMuted} />
            <Text style={styles.emptyTitle}>No offers yet</Text>
            <Text style={styles.emptyText}>
              Create your first offer above, or set prices for every bundle in a
              tier from Tier Management.
            </Text>
          </View>
        ) : (
          offerGroups.map((group) => (
            <View key={`group-${group.title}`} style={styles.groupCard}>
              <View style={styles.groupHeader}>
                <Ionicons name="layers" size={16} color={c.mintDim} />
                <Text style={styles.groupTitle}>
                  {group.title} ({group.items.length})
                </Text>
              </View>
              {group.items.map(renderOfferRow)}
            </View>
          ))
        )}
      </KeyboardAwareScrollView>
    </ThemedScreen>
  );
}

// Layered on the shared kit. The per-row action chips are the only genuinely
// screen-specific part: save is mint, pause/resume are amber/sky, and the
// destructive chip only goes rose once the user has armed the confirm tap.
const useOfferStyles = (c, topInset = 0) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    ...base,
    safeArea: { ...base.screen },
    loadingContainer: { ...base.center },
    loadingText: { ...base.headerSubtitle, marginTop: 12, fontSize: 15 },

    header: { ...base.header, paddingTop: 18 + topInset, paddingBottom: 12 },
    backButton: { ...base.backButton, borderRadius: 999 },
    refreshButton: { ...base.backButton, borderRadius: 999 },
    title: { ...base.headerTitle, flex: 1, textAlign: "center", fontSize: 20 },

    content: { ...base.body, paddingTop: 20, paddingBottom: 40 },

    infoCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: `${c.mint}14`,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: `${c.mint}2E`,
      padding: 14,
      marginBottom: 14,
    },
    infoText: {
      flex: 1,
      marginLeft: 10,
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 19,
      color: c.textSecondary,
    },
    errorCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: `${c.rose}14`,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: `${c.rose}33`,
      padding: 14,
      marginBottom: 14,
    },
    errorText: {
      flex: 1,
      marginLeft: 10,
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.rose,
    },

    createCard: {
      ...base.card,
      borderRadius: 22,
      padding: 16,
      marginBottom: 16,
    },
    createTitle: { ...base.sectionTitle, fontSize: 16, marginBottom: 10 },
    fieldLabel: { ...base.label, marginBottom: 6 },
    chipRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 2,
      marginBottom: 8,
    },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: c.canvasRaised,
      borderWidth: 1,
      borderColor: c.hairline,
      marginRight: 8,
    },
    chipActive: { backgroundColor: c.mint, borderColor: c.mint },
    chipText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.textSecondary,
    },
    chipTextActive: { color: c.onAccent },

    createPriceRow: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 4,
    },
    createButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.mint,
      paddingHorizontal: 16,
      paddingVertical: 13,
      borderRadius: 999,
      marginLeft: 10,
    },
    createButtonDisabled: { opacity: 0.55 },
    createButtonText: {
      fontFamily: fonts.bodyBold,
      color: c.onAccent,
      marginLeft: 6,
    },
    basePriceHint: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 6,
    },

    groupCard: {
      ...base.card,
      borderRadius: 22,
      padding: 16,
      marginBottom: 16,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 12,
    },
    groupTitle: {
      fontFamily: fonts.display,
      fontSize: 16,
      color: c.textPrimary,
      marginLeft: 8,
    },

    offerRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.canvasRaised,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 10,
      marginBottom: 8,
    },
    // Inactive rows stay legible rather than being hidden - agents need to
    // see that an offer exists but is switched off.
    offerRowInactive: { opacity: 0.6 },
    offerInfo: { flex: 1, marginRight: 8 },
    offerTitleRow: { flexDirection: "row", alignItems: "center" },
    offerTitle: {
      flexShrink: 1,
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.textPrimary,
      marginRight: 6,
    },
    networkBadge: {
      backgroundColor: `${c.mint}26`,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    networkBadgeText: {
      fontFamily: fonts.bodyBold,
      fontSize: 9,
      color: c.mint,
    },
    offerMeta: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 3,
    },
    offerStatus: {
      fontFamily: fonts.body,
      fontSize: 10,
      color: c.textMuted,
      marginTop: 2,
    },
    offerControls: { alignItems: "flex-end" },
    priceInputWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      borderRadius: 12,
      paddingHorizontal: 8,
      height: 36,
      width: 104,
    },
    currencyPrefix: {
      fontFamily: fonts.bodySemi,
      fontSize: 11,
      color: c.textMuted,
      marginRight: 4,
    },
    priceInput: {
      flex: 1,
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.textPrimary,
      paddingVertical: 0,
    },
    offerActions: { flexDirection: "row", marginTop: 6 },
    actionChip: {
      width: 30,
      height: 30,
      borderRadius: 999,
      justifyContent: "center",
      alignItems: "center",
      marginLeft: 6,
    },
    actionChipSave: { backgroundColor: c.mint },
    actionChipPause: { backgroundColor: c.amber },
    actionChipPlay: { backgroundColor: c.sky },
    // Idle delete is neutral so it does not shout; it only turns rose after
    // the first tap arms the confirm.
    actionChipDelete: { backgroundColor: c.surfaceHover },
    actionChipDeleteConfirm: { backgroundColor: c.rose },
    actionChipDisabled: { opacity: 0.55 },

    emptyCard: {
      ...base.card,
      borderRadius: 22,
      padding: 24,
      alignItems: "center",
    },
    emptyTitle: { ...base.rowTitle, fontSize: 16, marginTop: 10 },
    emptyText: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textMuted,
      textAlign: "center",
      marginTop: 6,
      lineHeight: 20,
    },
  });
};
