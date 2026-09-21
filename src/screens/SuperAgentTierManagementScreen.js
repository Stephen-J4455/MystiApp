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
import {
  upsertTierOffer,
  fetchCatalogPackages,
} from "../services/superAgentService";

const getPackageDescriptor = (pkg) => {
  if (!pkg) return "";
  const type = String(pkg.type || "").trim();
  const size =
    pkg.size !== undefined && pkg.size !== null && String(pkg.size).trim() !== ""
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
    pkg.size !== undefined && pkg.size !== null && String(pkg.size).trim() !== ""
      ? `${pkg.size}GB`.toUpperCase()
      : "";

  return (
    rows.find((row) => {
      if (String(row.network || "").toUpperCase() !== net) return false;
      const rowType = String(row.type || "").trim().toUpperCase();
      if (pkg.id && rowType === String(pkg.id).trim().toUpperCase()) return true;
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
      offersByKey[
        offerKey(offer.tier_name, offer.network, offer.data_value)
      ] = offer;
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
          console.error("Error loading tiers:", tiersResult.error);
        }
        if (packagesResult.error) {
          console.error("Error loading packages:", packagesResult.error);
        }
        if (pricingResult.error) {
          console.error("Error loading base prices:", pricingResult.error);
        }
        if (offersResult.error) {
          console.error("Error loading offers:", offersResult.error);
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
            onChangeText={(text) =>
              handlePriceChange(tier.id, pkgKey, text)
            }
            placeholder="0.00"
            placeholderTextColor="#9AA5AF"
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
              color="#fff"
            />
            <Text style={styles.deleteTierText}>
              {isConfirmingDelete ? "Sure?" : ""}
            </Text>
          </TouchableOpacity>
        </View>

        {filteredPackages.length === 0 ? (
          <Text style={styles.tierEmptyText}>No packages match this filter.</Text>
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
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.saveTierText}>
              Save {tier.name} Prices{changedCount > 0 ? ` (${changedCount})` : ""}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading tiers...</Text>
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
        <Text style={styles.title}>Tier Management</Text>
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
            Every bundle starts at the admin base price. Adjust the amounts to
            set what your agents pay in this tier, then save. Fields you leave
            blank keep the admin base price, and bundles with no base price yet
            are skipped.
          </Text>
        </View>

        {loadError ? (
          <View style={styles.errorCard}>
            <Ionicons name="warning-outline" size={18} color={colors.danger} />
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
            placeholderTextColor="#9AA5AF"
          />
          <TextInput
            style={[styles.input, styles.inputMultiline]}
            value={newTierDescription}
            onChangeText={setNewTierDescription}
            placeholder="Description (optional)"
            placeholderTextColor="#9AA5AF"
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
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="add-circle-outline" size={18} color="#fff" />
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
            <Ionicons name="layers-outline" size={40} color={colors.primary} />
            <Text style={styles.emptyTitle}>No tiers yet</Text>
            <Text style={styles.emptyText}>
              Create your first tier above (e.g. Gold, Silver), then set the
              price agents pay for each bundle.
            </Text>
          </View>
        ) : (
          tiers.map((tier) => renderTierSection(tier))
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
  input: {
    backgroundColor: colors.light,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.dark,
    marginBottom: 10,
  },
  inputMultiline: {
    minHeight: 64,
    textAlignVertical: "top",
  },
  createButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
  },
  createButtonDisabled: {
    opacity: 0.6,
  },
  createButtonText: {
    color: "#fff",
    fontWeight: "700",
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
    borderRadius: 20,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: 8,
  },
  networkChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  networkChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.dark,
  },
  networkChipTextActive: {
    color: "#fff",
  },
  tierCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: 16,
    marginBottom: 18,
  },
  tierHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  tierTitleWrap: {
    flex: 1,
  },
  tierName: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.primary,
  },
  tierDescription: {
    fontSize: 12,
    color: colors.dark,
    opacity: 0.7,
    marginTop: 2,
  },
  deleteTierButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  deleteTierButtonConfirm: {
    backgroundColor: colors.danger,
  },
  deleteTierText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    marginLeft: 4,
  },
  packageRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.light,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  packageInfo: {
    flex: 1,
    marginRight: 8,
  },
  packageName: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.dark,
  },
  packageMeta: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.65,
    marginTop: 2,
  },
  priceInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 8,
    height: 36,
    width: 112,
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
  tierEmptyText: {
    fontSize: 13,
    color: colors.dark,
    opacity: 0.6,
    textAlign: "center",
    paddingVertical: 12,
  },
  saveTierButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 6,
  },
  saveTierButtonDisabled: {
    backgroundColor: colors.border,
  },
  saveTierText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
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
