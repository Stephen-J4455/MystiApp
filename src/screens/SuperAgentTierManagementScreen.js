import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Platform,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import { getEdgeFunctionName } from "../lib/env";
import { getEdgeFunctionErrorMessage } from "../lib/edgeFunctions";
import { fonts } from "../components/theme";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import {
  upsertTierOffer,
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

const offerKey = (tierName, network, type) =>
  `${String(tierName || "")}::${packageKey(network, type)}`;

const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

const formatPriceInput = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
};

// Admin base prices are the default a tier price starts from. A base price of
// 0 counts as "not set" because tier prices must be greater than 0.
const usableBasePrice = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

export default function SuperAgentTierManagementScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [tiers, setTiers] = useState([]);
  const [packages, setPackages] = useState([]);
  const [basePriceMap, setBasePriceMap] = useState({});
  const [offerMap, setOfferMap] = useState({});
  const [priceInputs, setPriceInputs] = useState({});
  const [selectedNetwork, setSelectedNetwork] = useState("all");
  const [savingTierId, setSavingTierId] = useState(null);
  const [newTierName, setNewTierName] = useState("");
  const [newTierDescription, setNewTierDescription] = useState("");
  const [creatingTier, setCreatingTier] = useState(false);
  const [confirmDeleteTierId, setConfirmDeleteTierId] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const { showError, showSuccess, showInfo } = useNotification();
  const theme = useTheme();
  const c = theme.c;
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useTierStyles(c, topInset);
  // The bottom dock is absolutely positioned on native, so it floats over the
  // scroll view. Replaces the static `content` paddingBottom so the last tier's
  // save button is never stranded underneath it. Returns the plain `extra`
  // spacing on web, where there is no dock.
  const dockBottomPadding = useDockBottomPadding(10);

  const buildMaps = useCallback((tierRows, catalog, pricingRows, offers) => {
    const basePrices = {};
    (catalog || []).forEach((pkg) => {
      const row = findPricingRowForPackage(pricingRows, pkg);
      if (row) {
        basePrices[getPackageKey(pkg)] = Number(row.base_price);
      }
    });

    const offersByKey = {};
    (offers || []).forEach((offer) => {
      offersByKey[offerKey(offer.tier_name, offer.network, offer.data_value)] =
        offer;
    });

    const inputs = {};
    (tierRows || []).forEach((tier) => {
      (catalog || []).forEach((pkg) => {
        const pkgKey = getPackageKey(pkg);
        const key = `${tier.id}::${pkgKey}`;
        const desc = getPackageDescriptor(pkg);
        const existing =
          offersByKey[offerKey(tier.name, pkg.network, desc)] ||
          offersByKey[offerKey(tier.name, pkg.network, pkg.type)];
        // Default to the admin base price until the super agent sets their own.
        const basePrice = usableBasePrice(basePrices[pkgKey]);
        inputs[key] = existing
          ? String(existing.price)
          : basePrice !== null
            ? formatPriceInput(basePrice)
            : "";
      });
    });

    setBasePriceMap(basePrices);
    setOfferMap(offersByKey);
    setPriceInputs(inputs);
  }, []);

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
            "Tier Management is not included in the Pro badge.",
          );
          navigation.replace("Home");
          return;
        }

        setCurrentUser(user);

        const [tiersResult, packagesResult, pricingResult, offersResult] =
          await Promise.all([
            supabase.functions.invoke(
              getEdgeFunctionName("super-agent-tier-management"),
              { body: { action: "listTiers" } },
            ),
            supabase.functions.invoke(getEdgeFunctionName("get-packages")),
            supabase.functions.invoke(
              getEdgeFunctionName("super-agent-offers"),
              { body: { action: "getPackageBasePrices" } },
            ),
            supabase.functions.invoke(
              getEdgeFunctionName("super-agent-offers"),
              { body: { action: "listSuperAgentOffers" } },
            ),
          ]);

        if (tiersResult.error) {
          console.error(
            "Error loading tiers:",
            await getEdgeFunctionErrorMessage(tiersResult.error),
          );
        }
        if (packagesResult.error) {
          console.error("Error loading packages:", packagesResult.error);
        }
        if (pricingResult.error) {
          console.error(
            "Error loading base prices:",
            await getEdgeFunctionErrorMessage(pricingResult.error),
          );
        }
        if (offersResult.error) {
          console.error(
            "Error loading offers:",
            await getEdgeFunctionErrorMessage(offersResult.error),
          );
        }

        let catalog = packagesResult.data?.payload || [];
        if (!Array.isArray(catalog) || catalog.length === 0) {
          catalog = await fetchCatalogPackages();
        }

        const pricingRows = pricingResult.data?.pricing || [];
        const myOffers = offersResult.data?.offers || [];
        const tierRows = tiersResult.data?.tiers || [];

        setTiers(tierRows);
        setPackages(Array.isArray(catalog) ? catalog : []);

        if (!Array.isArray(catalog) || catalog.length === 0) {
          setLoadError(
            "Could not load the data bundle catalog. Pull down to retry.",
          );
        }

        buildMaps(tierRows, catalog, pricingRows, myOffers);
      } catch (error) {
        console.error("Error loading super agent tier screen:", error);
        setLoadError("Unable to load tier management right now.");
        showError("Error", "Unable to load tier management right now.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [buildMaps, navigation, showError],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData({ showSpinner: false });
  };

  const networkOptions = useMemo(() => {
    const networks = [];
    packages.forEach((pkg) => {
      const value = String(pkg.network || "").toUpperCase();
      if (value && !networks.includes(value)) networks.push(value);
    });
    return ["all", ...networks];
  }, [packages]);

  const filteredPackages = useMemo(() => {
    if (selectedNetwork === "all") return packages;
    return packages.filter(
      (pkg) =>
        String(pkg.network || "").toUpperCase() ===
        selectedNetwork.toUpperCase(),
    );
  }, [packages, selectedNetwork]);

  const tierChangedCount = useCallback(
    (tier) => {
      let count = 0;
      (packages || []).forEach((pkg) => {
        const pkgKey = getPackageKey(pkg);
        const inputKey = `${tier.id}::${pkgKey}`;
        const raw = (priceInputs[inputKey] ?? "").toString().trim();
        // Blank fields fall back to the admin base price when one is set.
        const basePrice = usableBasePrice(basePriceMap[pkgKey]);
        const effectiveRaw =
          raw !== "" ? raw : basePrice !== null ? String(basePrice) : "";
        if (effectiveRaw === "") return;
        const value = Number(effectiveRaw);
        if (!Number.isFinite(value) || value <= 0) return;
        const desc = getPackageDescriptor(pkg);
        const existing =
          offerMap[offerKey(tier.name, pkg.network, desc)] ||
          offerMap[offerKey(tier.name, pkg.network, pkg.type)];
        if (!existing || Math.abs(Number(existing.price) - value) > 0.0001) {
          count += 1;
        }
      });
      return count;
    },
    [packages, priceInputs, offerMap, basePriceMap],
  );

  const handlePriceChange = (tierId, pkgKey, text) => {
    const cleaned = text.replace(/[^0-9.]/g, "");
    const parts = cleaned.split(".");
    const normalized =
      parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : cleaned;
    setPriceInputs((prev) => ({
      ...prev,
      [`${tierId}::${pkgKey}`]: normalized,
    }));
  };

  const handleSaveTierPrices = async (tier) => {
    if (savingTierId) return;

    const updates = [];
    const invalidRows = [];

    (packages || []).forEach((pkg) => {
      const pkgKey = getPackageKey(pkg);
      const inputKey = `${tier.id}::${pkgKey}`;
      const raw = (priceInputs[inputKey] ?? "").toString().trim();
      // Blank fields are saved at the admin base price instead of being skipped.
      const basePrice = usableBasePrice(basePriceMap[pkgKey]);
      const effectiveRaw =
        raw !== "" ? raw : basePrice !== null ? String(basePrice) : "";
      if (effectiveRaw === "") return;

      const value = Number(effectiveRaw);
      if (!Number.isFinite(value) || value <= 0) {
        invalidRows.push(
          `${pkg.network} — ${pkg.size ? `${pkg.size} GB` : pkg.type}`,
        );
        return;
      }

      const desc = getPackageDescriptor(pkg);
      const existing =
        offerMap[offerKey(tier.name, pkg.network, desc)] ||
        offerMap[offerKey(tier.name, pkg.network, pkg.type)];
      if (!existing || Math.abs(Number(existing.price) - value) > 0.0001) {
        updates.push({ pkg, value, descriptor: desc });
      }
    });

    if (invalidRows.length > 0) {
      showError(
        "Invalid prices",
        `Enter an amount greater than 0 for: ${invalidRows.slice(0, 3).join(", ")}`,
      );
      return;
    }

    if (updates.length === 0) {
      showInfo(
        "Nothing to save",
        `All ${tier.name} tier prices are already up to date.`,
      );
      return;
    }

    try {
      setSavingTierId(tier.id);

      const results = await Promise.all(
        updates.map(async ({ pkg, value, descriptor }) => {
          try {
            await upsertTierOffer({
              superAgentId: currentUser.id,
              offer: {
                network: pkg.network,
                data_value: descriptor,
                tier_name: tier.name,
                price: value,
              },
            });
            return { error: null };
          } catch (err) {
            return { error: err?.message || "Failed to update price" };
          }
        }),
      );

      const failures = results.filter((result) => result.error);
      if (failures.length > 0) {
        throw new Error(failures[0].error);
      }

      showSuccess(
        "Tier prices saved",
        `${updates.length} ${tier.name} tier ${updates.length === 1 ? "price" : "prices"} updated.`,
      );
      await loadData({ showSpinner: false });
    } catch (saveError) {
      console.error("Error saving tier prices:", saveError);
      showError(
        "Error",
        saveError?.message || "Failed to save tier prices. Please try again.",
      );
    } finally {
      setSavingTierId(null);
    }
  };

  const handleCreateTier = async () => {
    const name = newTierName.trim();
    if (!name) {
      showError("Validation", "Enter a tier name (e.g. Gold, Silver).");
      return;
    }

    try {
      setCreatingTier(true);

      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-tier-management"),
        {
          body: {
            action: "createTier",
            tier: {
              name,
              description: newTierDescription.trim(),
            },
          },
        },
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      showSuccess("Tier created", `"${name}" is ready for pricing.`);
      setNewTierName("");
      setNewTierDescription("");
      await loadData({ showSpinner: false });
    } catch (tierError) {
      console.error("Error creating tier:", tierError);
      showError(
        "Error",
        tierError?.message?.includes("already exists")
          ? "A tier with this name already exists."
          : "Unable to create this tier right now.",
      );
    } finally {
      setCreatingTier(false);
    }
  };

  const handleDeleteTier = async (tier) => {
    if (!tier?.id) return;
    if (confirmDeleteTierId !== tier.id) {
      setConfirmDeleteTierId(tier.id);
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-tier-management"),
        { body: { action: "deleteTier", tier: { id: tier.id } } },
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      showSuccess("Tier deleted", `"${tier.name}" was removed.`);
      setConfirmDeleteTierId(null);
      await loadData({ showSpinner: false });
    } catch (tierError) {
      console.error("Error deleting tier:", tierError);
      showError("Error", "Unable to delete this tier right now.");
      setConfirmDeleteTierId(null);
    }
  };

  const renderPackageRow = (tier, pkg) => {
    const pkgKey = getPackageKey(pkg);
    const inputKey = `${tier.id}::${pkgKey}`;
    const basePrice = basePriceMap[pkgKey];
    const desc = getPackageDescriptor(pkg);
    const existing =
      offerMap[offerKey(tier.name, pkg.network, desc)] ||
      offerMap[offerKey(tier.name, pkg.network, pkg.type)];

    return (
      <View key={inputKey} style={styles.packageRow}>
        <View style={styles.packageInfo}>
          <Text style={styles.packageName}>
            {String(pkg.network || "").toUpperCase()} — {desc}
          </Text>
          <Text style={styles.packageMeta}>
            {pkg.size ? `${pkg.size} GB · ` : ""}Base:{" "}
            {basePrice !== undefined ? formatGhc(basePrice) : "not set"}
            {existing ? ` · Yours: ${formatGhc(existing.price)}` : ""}
          </Text>
        </View>
        <View style={styles.priceInputWrap}>
          <Text style={styles.currencyPrefix}>Ghc</Text>
          <TextInput
            style={styles.priceInput}
            value={priceInputs[inputKey] ?? ""}
            onChangeText={(text) => handlePriceChange(tier.id, pkgKey, text)}
            placeholder="0.00"
            placeholderTextColor={c.textMuted}
            keyboardType="decimal-pad"
          />
        </View>
      </View>
    );
  };

  const renderTierSection = (tier) => {
    const changedCount = tierChangedCount(tier);
    const isSaving = savingTierId === tier.id;
    const isConfirmingDelete = confirmDeleteTierId === tier.id;

    return (
      <View key={`tier-${tier.id}`} style={styles.tierCard}>
        <View style={styles.tierHeader}>
          <View style={styles.tierTitleWrap}>
            <Text style={styles.tierName}>{tier.name}</Text>
            {tier.description ? (
              <Text style={styles.tierDescription}>{tier.description}</Text>
            ) : null}
          </View>
          <TouchableOpacity
            style={[
              styles.deleteTierButton,
              isConfirmingDelete && styles.deleteTierButtonConfirm,
            ]}
            onPress={() => handleDeleteTier(tier)}
          >
            <Ionicons
              name={isConfirmingDelete ? "warning" : "trash-outline"}
              size={18}
              color={c.onAccent}
            />
            <Text style={styles.deleteTierText}>
              {isConfirmingDelete ? "Sure?" : ""}
            </Text>
          </TouchableOpacity>
        </View>

        {filteredPackages.length === 0 ? (
          <Text style={styles.tierEmptyText}>
            No packages match this filter.
          </Text>
        ) : (
          filteredPackages.map((pkg) => renderPackageRow(tier, pkg))
        )}

        <TouchableOpacity
          style={[
            styles.saveTierButton,
            (isSaving || changedCount === 0) && styles.saveTierButtonDisabled,
          ]}
          onPress={() => handleSaveTierPrices(tier)}
          disabled={isSaving || changedCount === 0}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color={c.onAccent} />
          ) : (
            <Text
              style={[
                styles.saveTierText,
                (isSaving || changedCount === 0) && styles.saveTierTextDisabled,
              ]}
            >
              Save {tier.name} Prices
              {changedCount > 0 ? ` (${changedCount})` : ""}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  if (loading) {
    return (
      <ThemedScreen style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={c.mint} />
          <Text style={styles.loadingText}>Loading tiers...</Text>
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
        <Text style={styles.title}>Tier Management</Text>
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
        contentContainerStyle={[
          styles.content,
          { paddingBottom: dockBottomPadding },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={20} color={c.mint} />
          <Text style={styles.infoText}>
            Every bundle starts at the admin base price. Adjust the amounts to
            set what your agents pay in this tier, then save. Fields you leave
            blank keep the admin base price, and bundles with no base price yet
            are skipped.
          </Text>
        </View>

        {loadError ? (
          <View style={styles.errorCard}>
            <Ionicons name="warning-outline" size={18} color={c.rose} />
            <Text style={styles.errorText}>{loadError}</Text>
          </View>
        ) : null}

        <View style={styles.createCard}>
          <Text style={styles.createTitle}>Create a Tier</Text>
          <TextInput
            style={styles.input}
            value={newTierName}
            onChangeText={setNewTierName}
            placeholder="Tier name (e.g. Gold)"
            placeholderTextColor={c.textMuted}
          />
          <TextInput
            style={[styles.input, styles.inputMultiline]}
            value={newTierDescription}
            onChangeText={setNewTierDescription}
            placeholder="Description (optional)"
            placeholderTextColor={c.textMuted}
            multiline
          />
          <TouchableOpacity
            style={[
              styles.createButton,
              creatingTier && styles.createButtonDisabled,
            ]}
            onPress={handleCreateTier}
            disabled={creatingTier}
          >
            {creatingTier ? (
              <ActivityIndicator size="small" color={c.onAccent} />
            ) : (
              <>
                <Ionicons
                  name="add-circle-outline"
                  size={18}
                  color={c.onAccent}
                />
                <Text style={styles.createButtonText}>Add Tier</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {networkOptions.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.networkFilterRow}
          >
            {networkOptions.map((option) => (
              <TouchableOpacity
                key={option}
                style={[
                  styles.networkChip,
                  selectedNetwork === option && styles.networkChipActive,
                ]}
                onPress={() => setSelectedNetwork(option)}
              >
                <Text
                  style={[
                    styles.networkChipText,
                    selectedNetwork === option && styles.networkChipTextActive,
                  ]}
                >
                  {option === "all" ? "All Networks" : option}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}

        {tiers.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="layers-outline" size={40} color={c.textMuted} />
            <Text style={styles.emptyTitle}>No tiers yet</Text>
            <Text style={styles.emptyText}>
              Create your first tier above (e.g. Gold, Silver), then set the
              price agents pay for each bundle.
            </Text>
          </View>
        ) : (
          tiers.map((tier) => renderTierSection(tier))
        )}
      </KeyboardAwareScrollView>
    </ThemedScreen>
  );
}

// Layered on the shared kit: `themedStyles(c)` owns the surface, border and type
// ramp, so this file only adds the tier-specific pieces and the semantic
// tones (info strip, destructive confirm).
const useTierStyles = (c, topInset = 0) => {
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

    // Informational strip uses the mint tint so it reads as guidance, not an
    // error; the error card below it is the rose-tinted counterpart.
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
    input: {
      backgroundColor: c.canvasRaised,
      borderWidth: 1,
      borderColor: c.hairline,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontFamily: fonts.body,
      fontSize: 14,
      color: c.textPrimary,
      marginBottom: 10,
    },
    inputMultiline: { minHeight: 64, textAlignVertical: "top" },
    createButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.mint,
      paddingVertical: 14,
      borderRadius: 999,
    },
    createButtonDisabled: { opacity: 0.55 },
    createButtonText: {
      fontFamily: fonts.bodyBold,
      color: c.onAccent,
      marginLeft: 6,
    },

    networkFilterRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 4,
      marginBottom: 8,
    },
    networkChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      marginRight: 8,
    },
    networkChipActive: { backgroundColor: c.mint, borderColor: c.mint },
    networkChipText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.textSecondary,
    },
    networkChipTextActive: { color: c.onAccent },

    tierCard: { ...base.card, borderRadius: 22, padding: 16, marginBottom: 18 },
    tierHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      marginBottom: 12,
    },
    tierTitleWrap: { flex: 1 },
    tierName: { fontFamily: fonts.display, fontSize: 18, color: c.textPrimary },
    tierDescription: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    // Idle delete is muted; the confirm state flips it to rose so the
    // destructive intent is obvious before the second tap.
    deleteTierButton: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surfaceHover,
      borderWidth: 1,
      borderColor: c.hairline,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
    },
    deleteTierButtonConfirm: { backgroundColor: c.rose, borderColor: c.rose },
    deleteTierText: {
      fontFamily: fonts.bodyBold,
      fontSize: 11,
      color: c.textMuted,
      marginLeft: 4,
    },

    packageRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.canvasRaised,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 10,
      marginBottom: 8,
    },
    packageInfo: { flex: 1, marginRight: 8 },
    packageName: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.textPrimary,
    },
    packageMeta: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 2,
    },
    priceInputWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      borderRadius: 12,
      paddingHorizontal: 8,
      height: 38,
      width: 112,
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
    tierEmptyText: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textMuted,
      textAlign: "center",
      paddingVertical: 12,
    },
    saveTierButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.mint,
      paddingVertical: 14,
      borderRadius: 999,
      marginTop: 6,
    },
    // Disabled save greys out rather than going invisible, so the row keeps
    // its shape when there is nothing to save.
    saveTierButtonDisabled: { backgroundColor: c.surfaceHover },
    saveTierText: {
      fontFamily: fonts.bodyBold,
      fontSize: 14,
      color: c.onAccent,
    },
    saveTierTextDisabled: { color: c.textMuted },

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
