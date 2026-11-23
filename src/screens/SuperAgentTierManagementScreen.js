import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { getEdgeFunctionName } from "../lib/env";
import { getEdgeFunctionErrorMessage } from "../lib/edgeFunctions";
import { fonts } from "../components/theme";
import { themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import { buildTierOverview, formatGhc } from "../lib/superAgentPricing";

const changeTier = async (action, tier) => {
  const { data, error } = await supabase.functions.invoke(
    getEdgeFunctionName("super-agent-tier-management"),
    { body: { action, tier } },
  );
  if (error) throw new Error(await getEdgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return data;
};

export default function TiersPanel({ tiers, cards, roster, setTiers, refreshing, onRefresh, setMutating }) {
  const [newTierName, setNewTierName] = useState("");
  const [newTierDescription, setNewTierDescription] = useState("");
  const [creatingTier, setCreatingTier] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [confirmDeleteTierId, setConfirmDeleteTierId] = useState(null);
  const [deletingTierId, setDeletingTierId] = useState(null);
  const [expandedTier, setExpandedTier] = useState(null);
  const { showError, showSuccess } = useNotification();
  const { c } = useTheme();
  const styles = useTierStyles(c);
  const dockBottomPadding = useDockBottomPadding(16);
  const busy = refreshing || creatingTier || deletingTierId !== null;
  const rosterStatus = roster?.status;
  const agents = roster?.agents;
  const overview = useMemo(
    () => buildTierOverview(tiers, cards, agents || []),
    [tiers, cards, agents],
  );

  const handleCreateTier = async () => {
    const name = newTierName.trim();
    if (busy || !name) return;

    setCreatingTier(true);
    setMutating(true);
    setCreateError(null);
    try {
      const { tier } = await changeTier("createTier", {
        name,
        description: newTierDescription.trim(),
      });
      if (!tier?.id) throw new Error("Tier creation was not confirmed.");
      setTiers((previous) => [tier, ...previous.filter((item) => item.id !== tier.id)]);
      setNewTierName("");
      setNewTierDescription("");
      setCreateVisible(false);
      showSuccess("Tier created", `"${tier.name}" was added.`);
    } catch (error) {
      setCreateError(
        /already exists|duplicate/i.test(error?.message || "")
          ? "A tier with this name already exists."
          : "Unable to create this tier right now.",
      );
    } finally {
      setCreatingTier(false);
      setMutating(false);
    }
  };

  const handleDeleteTier = async (tier) => {
    if (busy) return;
    if (confirmDeleteTierId !== tier.id) {
      setConfirmDeleteTierId(tier.id);
      return;
    }

    setDeletingTierId(tier.id);
    setMutating(true);
    try {
      const result = await changeTier("deleteTier", { id: tier.id });
      if (result?.success !== true) throw new Error("Tier deletion was not confirmed.");
      setTiers((previous) => previous.filter((item) => item.id !== tier.id));
      setExpandedTier((selected) => selected === String(tier.id) ? null : selected);
      setConfirmDeleteTierId(null);
      showSuccess("Tier deleted", `"${tier.name}" was removed.`);
    } catch (error) {
      console.error("Error deleting tier:", error);
      showError("Error", "Unable to delete this tier right now.");
    } finally {
      setDeletingTierId(null);
      setMutating(false);
    }
  };

  return (
    <>
      <FlatList
        data={overview}
        keyExtractor={(tier) => tier.id === null ? "general" : String(tier.id)}
        contentContainerStyle={[styles.content, { paddingBottom: dockBottomPadding }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.sectionTitle}>{overview.length} {overview.length === 1 ? "tier" : "tiers"}</Text>
            <TouchableOpacity
              style={[styles.newTierButton, busy && styles.disabled]}
              onPress={() => {
                setCreateError(null);
                setCreateVisible(true);
              }}
              disabled={busy}
              accessibilityRole="button"
            >
              <Ionicons name="add" size={18} color={c.onAccent} />
              <Text style={styles.createButtonText}>New tier</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item: tier }) => {
          const general = tier.id === null;
          const key = general ? "general" : String(tier.id);
          const expanded = expandedTier === key;
          const confirming = !general && confirmDeleteTierId === tier.id;
          return (
            <View style={styles.tierCard}>
              <View style={styles.tierRow}>
                <TouchableOpacity
                  style={styles.tierToggle}
                  onPress={() => setExpandedTier(expanded ? null : key)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                >
                  <View style={styles.tierIcon}>
                    <Ionicons name={general ? "people-outline" : "layers-outline"} size={19} color={c.mint} />
                  </View>
                  <View style={styles.tierText}>
                    <Text style={styles.tierName}>{tier.name}</Text>
                    {general || tier.description ? (
                      <Text style={styles.tierDescription}>
                        {general ? "Default for sub-agents without a tier" : tier.description}
                      </Text>
                    ) : null}
                    <Text style={styles.tierDescription}>
                      {tier.packages.length} {tier.packages.length === 1 ? "package" : "packages"}
                      {rosterStatus === "ready"
                        ? ` · ${tier.agents.length} ${tier.agents.length === 1 ? "sub-agent" : "sub-agents"}`
                        : ""}
                    </Text>
                  </View>
                  <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={17} color={c.textSecondary} />
                </TouchableOpacity>
                {!general ? (
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => setConfirmDeleteTierId(confirming ? null : tier.id)}
                    disabled={busy}
                    accessibilityLabel={`Delete ${tier.name} tier`}
                  >
                    <Ionicons name="trash-outline" size={18} color={c.rose} />
                  </TouchableOpacity>
                ) : null}
              </View>
              {confirming ? (
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmText}>Delete this tier?</Text>
                  <TouchableOpacity onPress={() => setConfirmDeleteTierId(null)} disabled={busy}>
                    <Text style={styles.cancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.confirmDeleteButton}
                    onPress={() => handleDeleteTier(tier)}
                    disabled={busy}
                  >
                    {deletingTierId === tier.id ? (
                      <ActivityIndicator size="small" color={c.onAccent} />
                    ) : (
                      <Text style={styles.createButtonText}>Delete</Text>
                    )}
                  </TouchableOpacity>
                </View>
              ) : null}
              {expanded ? (
                <View style={styles.details}>
                  <Text style={styles.detailTitle}>Packages</Text>
                  {tier.packages.length ? tier.packages.map((pkg) => (
                    <View key={pkg.key} style={styles.detailRow}>
                      <View style={styles.tierText}>
                        <Text style={styles.detailName}>{pkg.name}</Text>
                        <Text style={styles.tierDescription}>
                          {pkg.network} · {pkg.provider}{pkg.inherited ? " · General price" : ""}
                        </Text>
                      </View>
                      <Text style={styles.detailPrice}>{pkg.price === null ? "Unavailable" : formatGhc(pkg.price)}</Text>
                    </View>
                  )) : <Text style={styles.tierDescription}>No published packages for this tier.</Text>}

                  <Text style={styles.detailTitle}>Assigned sub-agents</Text>
                  {rosterStatus === "ready" ? (
                    tier.agents.length ? tier.agents.map((agent) => (
                      <View key={agent.id} style={styles.detailRow}>
                        <Ionicons name="person-outline" size={15} color={c.textMuted} />
                        <Text style={styles.detailName}>{agent.name}</Text>
                      </View>
                    )) : <Text style={styles.tierDescription}>No sub-agents assigned.</Text>
                  ) : (
                    <Text style={styles.tierDescription}>
                      {rosterStatus === "error" ? "Could not load assignments. Pull down to retry." : "Loading assignments…"}
                    </Text>
                  )}
                </View>
              ) : null}
            </View>
          );
        }}
      />

      <Modal
        visible={createVisible}
        transparent
        animationType="fade"
        onRequestClose={() => !creatingTier && setCreateVisible(false)}
      >
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="padding">
          <View style={styles.modalCard} accessibilityViewIsModal>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Create a tier</Text>
              <TouchableOpacity
                onPress={() => setCreateVisible(false)}
                disabled={creatingTier}
                accessibilityLabel="Close tier creation"
                hitSlop={10}
              >
                <Ionicons name="close" size={22} color={c.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.fieldLabel}>Tier name</Text>
            <TextInput
              style={styles.input}
              value={newTierName}
              onChangeText={(name) => {
                setNewTierName(name);
                setCreateError(null);
              }}
              placeholder="e.g. Gold"
              placeholderTextColor={c.textMuted}
              editable={!creatingTier}
              accessibilityLabel="Tier name"
            />
            <Text style={styles.fieldLabel}>Description (optional)</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={newTierDescription}
              onChangeText={setNewTierDescription}
              placeholderTextColor={c.textMuted}
              editable={!creatingTier}
              accessibilityLabel="Tier description"
              multiline
            />
            {createError ? (
              <Text style={styles.createError} accessibilityLiveRegion="polite">{createError}</Text>
            ) : null}
            <TouchableOpacity
              style={[styles.createButton, (creatingTier || !newTierName.trim()) && styles.createButtonDisabled]}
              onPress={handleCreateTier}
              disabled={creatingTier || !newTierName.trim()}
            >
              {creatingTier ? (
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Text style={styles.createButtonText}>Create tier</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const useTierStyles = (c) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    content: { ...base.body, paddingTop: 12 },
    listHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
    sectionTitle: { ...base.sectionTitle, fontSize: 17 },
    newTierButton: {
      flexDirection: "row", gap: 4, alignItems: "center", minHeight: 40,
      paddingHorizontal: 13, borderRadius: 11, backgroundColor: c.mint,
    },
    disabled: { opacity: 0.55 },
    tierCard: { ...base.card, borderRadius: 17, padding: 13, marginBottom: 10 },
    tierRow: { flexDirection: "row", alignItems: "center", gap: 11 },
    tierToggle: { flex: 1, flexDirection: "row", alignItems: "center", gap: 11, minHeight: 44 },
    tierIcon: {
      width: 36, height: 36, borderRadius: 11, backgroundColor: `${c.mint}18`,
      alignItems: "center", justifyContent: "center",
    },
    tierText: { flex: 1 },
    tierName: { fontFamily: fonts.bodyBold, fontSize: 15, color: c.textPrimary },
    tierDescription: { fontFamily: fonts.body, fontSize: 12, color: c.textSecondary, marginTop: 3 },
    deleteButton: { minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center" },
    confirmRow: {
      flexDirection: "row", alignItems: "center", gap: 12, marginTop: 10,
      paddingTop: 10, borderTopWidth: 1, borderTopColor: c.hairline,
    },
    confirmText: { flex: 1, fontFamily: fonts.bodySemi, fontSize: 12, color: c.textPrimary },
    cancelText: { fontFamily: fonts.bodySemi, fontSize: 12, color: c.textSecondary },
    confirmDeleteButton: { minWidth: 64, alignItems: "center", borderRadius: 9, padding: 9, backgroundColor: c.rose },
    details: { marginTop: 10, borderTopWidth: 1, borderTopColor: c.hairline },
    detailTitle: { fontFamily: fonts.bodyBold, fontSize: 13, color: c.textSecondary, marginTop: 11, marginBottom: 4 },
    detailRow: {
      flexDirection: "row", alignItems: "center", gap: 8, minHeight: 34,
      paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.hairline,
    },
    detailName: { fontFamily: fonts.bodySemi, fontSize: 13, color: c.textPrimary, flexShrink: 1 },
    detailPrice: { fontFamily: fonts.bodyBold, fontSize: 12, color: c.textPrimary },
    modalBackdrop: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0, 0, 0, 0.5)" },
    modalCard: {
      width: "100%", maxWidth: 420, alignSelf: "center", padding: 18,
      borderRadius: 20, borderWidth: 1, borderColor: c.hairline, backgroundColor: c.surface,
    },
    modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
    modalTitle: { fontFamily: fonts.display, fontSize: 17, color: c.textPrimary },
    fieldLabel: { fontFamily: fonts.bodySemi, color: c.textSecondary, fontSize: 13, marginTop: 10, marginBottom: 6 },
    input: {
      backgroundColor: c.canvasRaised, borderWidth: 1, borderColor: c.hairline, borderRadius: 14,
      paddingHorizontal: 14, paddingVertical: 12, fontFamily: fonts.body, fontSize: 14,
      color: c.textPrimary, marginBottom: 10,
    },
    inputMultiline: { minHeight: 64, textAlignVertical: "top" },
    createError: { color: c.rose, fontFamily: fonts.body, fontSize: 13, marginBottom: 10 },
    createButton: { alignItems: "center", backgroundColor: c.mint, paddingVertical: 14, borderRadius: 13 },
    createButtonDisabled: { opacity: 0.55 },
    createButtonText: { fontFamily: fonts.bodyBold, color: c.onAccent },
  });
};
