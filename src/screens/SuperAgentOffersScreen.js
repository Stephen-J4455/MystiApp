import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { useNotification } from "../contexts/NotificationContext";
import { fonts } from "../components/theme";
import { themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import {
  upsertTierOffer,
  updateSuperAgentOffer,
  deleteSuperAgentOffer,
} from "../services/superAgentService";

import {
  formatGhc,
  formatPriceInput,
  getBundleFamily,
  getOffersProviderLabel,
  normalizeName,
  normalizeNetwork,
  providerOf,
  tierOf,
  usableBasePrice,
} from "../lib/superAgentPricing";

export default function OffersPanel({
  cards,
  setOffers,
  tiers,
  userId,
  refreshing,
  onRefresh,
  setMutating,
}) {
  const [tierSelections, setTierSelections] = useState({});
  const [drafts, setDrafts] = useState({});
  const [changingCard, setChangingCard] = useState(null);
  const changeInFlight = useRef(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [selectedNetwork, setSelectedNetwork] = useState("all");
  const [selectedFamily, setSelectedFamily] = useState("all");

  const { showError, showSuccess } = useNotification();
  const { c } = useTheme();
  const styles = useOfferStyles(c);
  const dockBottomPadding = useDockBottomPadding(16);
  const busy = refreshing || changingCard !== null;

  const providerFilter = cards.some(({ pkg }) => providerOf(pkg) === selectedProvider)
    ? selectedProvider
    : "all";
  const providerCards = cards.filter(({ pkg }) => providerFilter === "all" || providerOf(pkg) === providerFilter);
  const networks = [...new Set(providerCards.map(({ pkg }) => normalizeNetwork(pkg.network)).filter(Boolean))];
  const networkFilter = networks.includes(selectedNetwork) ? selectedNetwork : "all";
  const networkCards = providerCards.filter(
    ({ pkg }) => networkFilter === "all" || normalizeNetwork(pkg.network) === networkFilter,
  );
  const families = new Set(networkCards.map(({ pkg }) => getBundleFamily(pkg)));
  const familyFilter = families.has(selectedFamily) ? selectedFamily : "all";
  const filteredCards = networkCards.filter(
    ({ pkg }) => familyFilter === "all" || getBundleFamily(pkg) === familyFilter,
  );

  const clearDraft = (key) => {
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  const runChange = async (card, action) => {
    if (busy || changeInFlight.current) return;
    changeInFlight.current = true;
    setChangingCard(card.key);
    setMutating(true);
    try {
      await action();
    } catch (error) {
      console.error("Error updating offer:", error);
      showError("Offer update failed", "Your price edit is still available. Try again.");
    } finally {
      changeInFlight.current = false;
      setChangingCard(null);
      setMutating(false);
    }
  };

  const retainSavedOffer = (result) => {
    if (!result?.offer?.id) throw new Error("Offer update was not confirmed.");
    const saved = result.offer;
    setOffers((previous) =>
      previous.some((offer) => offer.id === saved.id)
        ? previous.map((offer) => offer.id === saved.id ? saved : offer)
        : [...previous, saved],
    );
  };

  const handleSave = (card, tier, offer, draftKey, value, linked = false) => {
    const price = usableBasePrice(linked ? card.base : value);
    if (price === null) {
      showError("Invalid price", "Enter an amount greater than zero.");
      return;
    }

    return runChange(card, async () => {
      const updates = { price, uses_admin_base_price: linked };
      const result = offer
        ? await updateSuperAgentOffer({ offerId: offer.id, updates })
        : await upsertTierOffer({
            superAgentId: userId,
            offer: {
              ...updates,
              provider: providerOf(card.pkg),
              network: card.pkg.network,
              data_value: card.descriptor,
              tier_name: tier || null,
            },
          });

      retainSavedOffer(result);
      clearDraft(draftKey);
      showSuccess("Offer saved", `${tier || "General"} price is ${formatGhc(price)}.`);
    });
  };

  const handleToggle = (card, offer) => runChange(card, async () => {
    retainSavedOffer(await updateSuperAgentOffer({
      offerId: offer.id,
      updates: { is_active: !offer.is_active },
    }));
  });

  const handleRemove = (card, offer, draftKey) => {
    if (confirmDeleteId !== offer.id) {
      setConfirmDeleteId(offer.id);
      return;
    }
    return runChange(card, async () => {
      await deleteSuperAgentOffer(offer.id);
      setOffers((previous) => previous.filter((row) => row.id !== offer.id));
      clearDraft(draftKey);
      setConfirmDeleteId(null);
      showSuccess("Offer removed", "This price is no longer published.");
    });
  };

  const renderOptions = (label, options, selected, onSelect, disabled = false) => (
    <View style={styles.filterSection}>
      <Text style={styles.filterLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {options.map(({ key, label: title }) => (
          <TouchableOpacity
            key={key}
            style={[styles.choiceButton, key === selected && styles.chipActive]}
            onPress={() => onSelect(key)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ selected: key === selected, disabled }}
          >
            <Text style={[styles.chipText, key === selected && styles.chipTextActive]}>{title}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  const renderCard = ({ item: card }) => {
    const tierNames = [...new Set([
      "",
      ...tiers.map(({ name }) => name),
      ...card.offers.map(tierOf),
    ])];
    const defaultTier = card.offers.find((offer) => !tierOf(offer))
      ? ""
      : tierOf(card.offers[0] || {});
    const selected = tierSelections[card.key];
    const tier = tierNames.includes(selected) ? selected : defaultTier;
    const offer = card.offers.find((row) => normalizeName(tierOf(row)) === normalizeName(tier));
    const draftKey = JSON.stringify([card.key, tier]);
    const savedPrice = offer?.uses_admin_base_price && card.base !== null ? card.base : offer?.price;
    const initialPrice = savedPrice ?? card.base;
    const draft = drafts[draftKey];
    const input = draft ?? (initialPrice == null ? "" : formatPriceInput(initialPrice));
    const price = usableBasePrice(input);
    const isDirty = draft !== undefined && (price === null || price !== Number(savedPrice));
    const editable = Boolean(offer || card.base !== null);
    const pending = changingCard === card.key;
    const margin = card.base !== null && price !== null ? price - card.base : null;

    return (
      <View style={[styles.offerRow, isDirty && styles.offerRowDirty]}>
        <View style={styles.offerHeader}>
          <View style={styles.offerInfo}>
            <View style={styles.offerTitleRow}>
              <Text style={styles.offerTitle} numberOfLines={2}>{card.descriptor || offer?.title}</Text>
              {card.pkg.size ? (
                <View style={styles.networkBadge}>
                  <Text style={styles.networkBadgeText}>{card.pkg.size} GB</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.offerMeta}>
              {normalizeNetwork(card.pkg.network)} · {getOffersProviderLabel(card.pkg.provider)}
            </Text>
          </View>
          {offer ? (
            <Switch
              value={offer.is_active === true}
              onValueChange={() => handleToggle(card, offer)}
              disabled={busy}
              accessibilityLabel={`Activate ${card.descriptor} for ${tier || "General"}`}
              trackColor={{ false: c.hairlineStrong, true: c.mint }}
            />
          ) : null}
        </View>

        {renderOptions(
          "Tier",
          tierNames.map((name) => ({ key: name, label: name || "General" })),
          tier,
          (name) => {
            setTierSelections((previous) => ({ ...previous, [card.key]: name }));
            setConfirmDeleteId(null);
          },
          pending,
        )}

        <View style={styles.priceFields}>
          <View style={styles.priceField}>
            <Text style={styles.filterLabel}>Admin base</Text>
            <Text style={styles.priceValue}>{card.base === null ? "Not set" : formatGhc(card.base)}</Text>
          </View>
          <View style={styles.priceField}>
            <Text style={styles.filterLabel}>Offer price</Text>
            <View style={[styles.priceInputWrap, isDirty && styles.priceInputDirty]}>
              <Text style={styles.currencyPrefix}>Ghc</Text>
              <TextInput
                style={styles.priceInput}
                value={input}
                onChangeText={(text) => {
                  const [whole, ...decimals] = text.replace(/[^0-9.]/g, "").split(".");
                  const value = decimals.length ? `${whole}.${decimals.join("")}` : whole;
                  setDrafts((previous) => ({ ...previous, [draftKey]: value }));
                }}
                editable={editable && !busy}
                keyboardType="decimal-pad"
                accessibilityLabel={`Offer price for ${card.descriptor}, ${tier || "General"}`}
              />
            </View>
          </View>
          <View style={styles.priceField}>
            <Text style={styles.filterLabel}>Margin</Text>
            <Text style={[styles.priceValue, margin < 0 && styles.negativeMargin]}>
              {margin === null ? "—" : formatGhc(margin)}
            </Text>
          </View>
        </View>

        <View style={styles.offerFooter}>
          <View style={styles.offerInfo}>
            <Text style={styles.offerStatus}>
              {offer ? (offer.is_active ? "Active" : "Paused") : "Not published"}
              {offer?.uses_admin_base_price ? " · Linked to admin base" : ""}
            </Text>
            {offer && !offer.uses_admin_base_price && card.base !== null ? (
              <TouchableOpacity onPress={() => handleSave(card, tier, offer, draftKey, card.base, true)} disabled={busy}>
                <Text style={styles.basePriceLink}>Use admin base price</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {offer ? (
            <TouchableOpacity
              style={[styles.actionChip, confirmDeleteId === offer.id && styles.actionChipDeleteConfirm]}
              onPress={() => handleRemove(card, offer, draftKey)}
              disabled={busy}
              accessibilityLabel={confirmDeleteId === offer.id ? "Confirm offer removal" : "Remove offer"}
            >
              <Ionicons
                name={confirmDeleteId === offer.id ? "warning-outline" : "trash-outline"}
                size={17}
                color={confirmDeleteId === offer.id ? c.onAccent : c.textSecondary}
              />
            </TouchableOpacity>
          ) : null}
          {editable ? (
            <TouchableOpacity
              style={[styles.saveButton, (busy || (offer && !isDirty)) && styles.buttonDisabled]}
              onPress={() => handleSave(card, tier, offer, draftKey, input, !offer && draft === undefined)}
              disabled={busy || Boolean(offer && !isDirty)}
            >
              {pending ? <ActivityIndicator size="small" color={c.onAccent} /> : (
                <Text style={styles.saveButtonText}>Save price</Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  };

  const all = [{ key: "all", label: "All" }];
  const providers = [...new Set(cards.map(({ pkg }) => providerOf(pkg)))];
  return (
      <FlatList
        data={filteredCards}
        keyExtractor={(card) => card.key}
        renderItem={renderCard}
        renderScrollComponent={(props) => <KeyboardAwareScrollView {...props} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={[styles.content, { paddingBottom: dockBottomPadding }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            {cards.length ? (
              <View style={styles.filterCard}>
                {providers.length > 1 ? renderOptions("Provider", [
                  ...all, ...providers.map((key) => ({ key, label: getOffersProviderLabel(key) })),
                ], providerFilter, setSelectedProvider) : null}
                {networks.length > 1 ? renderOptions("Network", [
                  ...all, ...networks.map((key) => ({ key, label: key })),
                ], networkFilter, setSelectedNetwork) : null}
                {families.size > 1 ? renderOptions("Bundle", [
                  ...all,
                  ...[
                    { key: "ishare", label: "iShare" },
                    { key: "big_time", label: "Big Time" },
                    { key: "everyday", label: "Everyday" },
                  ].filter(({ key }) => families.has(key)),
                ], familyFilter, setSelectedFamily) : null}
                <Text style={styles.resultCount}>
                  {filteredCards.length} {filteredCards.length === 1 ? "package" : "packages"}
                </Text>
              </View>
            ) : null}
          </>
        }
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Ionicons name="cube-outline" size={32} color={c.textMuted} />
            <Text style={styles.emptyTitle}>No packages available</Text>
            <Text style={styles.emptyText}>Packages appear when the admin sets a base price.</Text>
          </View>
        }
      />
  );
}

const useOfferStyles = (c) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    filterSection: { marginTop: 9, marginBottom: 2 },
    filterLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 11,
      color: c.textMuted,
      marginBottom: 6,
    },
    choiceButton: {
      paddingHorizontal: 13,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: c.canvasRaised,
      borderWidth: 1,
      borderColor: c.hairline,
      marginRight: 8,
      marginBottom: 6,
    },
    chipActive: { backgroundColor: c.mint, borderColor: c.mint },
    chipText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.textSecondary,
    },
    chipTextActive: { color: c.onAccent },
    offerRow: {
      backgroundColor: c.surface,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 13,
      marginBottom: 10,
    },
    offerRowDirty: { borderColor: c.mint },
    offerHeader: { flexDirection: "row", alignItems: "center" },
    offerInfo: { flex: 1, marginRight: 8 },
    offerTitleRow: { flexDirection: "row", alignItems: "center" },
    offerTitle: {
      flexShrink: 1,
      fontFamily: fonts.bodySemi,
      fontSize: 15,
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
    priceFields: { flexDirection: "row", gap: 8, marginTop: 12, alignItems: "center" },
    priceField: { flex: 1, minWidth: 0 },
    priceValue: { color: c.textPrimary, fontFamily: fonts.bodySemi, fontSize: 12 },
    priceInputWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.canvasRaised,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      borderRadius: 12,
      paddingHorizontal: 8,
      height: 36,
      minWidth: 0,
    },
    priceInputDirty: { borderColor: c.mint },
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
    negativeMargin: { color: c.rose },
    offerFooter: {
      flexDirection: "row",
      alignItems: "center",
      paddingTop: 10,
      marginTop: 10,
      borderTopWidth: 1,
      borderTopColor: c.hairline,
    },
    offerStatus: {
      fontFamily: fonts.body,
      fontSize: 10,
      color: c.textMuted,
      marginTop: 2,
    },
    basePriceLink: {
      fontFamily: fonts.bodySemi,
      fontSize: 11,
      color: c.mint,
      marginTop: 4,
    },
    actionChip: {
      width: 36,
      height: 36,
      borderRadius: 10,
      justifyContent: "center",
      alignItems: "center",
      marginLeft: 6,
    },
    actionChipDeleteConfirm: { backgroundColor: c.rose },
    saveButton: {
      minHeight: 38,
      minWidth: 84,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 11,
      borderRadius: 11,
      marginLeft: 7,
      backgroundColor: c.mint,
    },
    buttonDisabled: { opacity: 0.5 },
    saveButtonText: { fontFamily: fonts.bodyBold, color: c.onAccent, fontSize: 12 },
    content: { ...base.body, paddingTop: 12, paddingBottom: 14 },
    filterCard: {
      ...base.card,
      borderRadius: 20,
      padding: 14,
      marginBottom: 16,
    },
    resultCount: { fontFamily: fonts.bodySemi, fontSize: 12, color: c.textMuted, marginTop: 4 },
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
