import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConfirmDialog, Field, PrimaryButton, ScreenHeader, SecondaryButton, ThemedScreen } from "../components/ui";
import { useProfile } from "../contexts/ProfileContext";
import { useTheme } from "../contexts/ThemeContext";
import { useNotification } from "../contexts/NotificationContext";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import { copyToClipboard } from "../lib/clipboard";
import { getProviderDisplayName } from "../lib/providerDisplay";
import {
  loadStorefront, loadStoreOrders, loadTierCatalog, orderPageSize, pesewasToCedis, resolveStoreOrder,
  deleteStorefront, saveStorefront, saveStoreTierSelection, saveStoreTier, saveTierItem, selectedStoreTier, storeLink,
  defaultBranding, isStoreColor, safeStoreUrl, storeColors, storeContacts, storeIcons, storeTemplates, storeThemes,
} from "../lib/storefront";

const emptyStore = { name: "", slug: "", published: false, ...defaultBranding };
const emptyTier = { name: "", active: true };
const emptyItem = { price: "", active: true };
const statuses = { pending: "Pending", fulfilled: "Fulfilled", declined: "Declined" };
const orderDate = new Intl.DateTimeFormat("en-GH", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Accra",
});

function Panel({ title, children }) {
  const { c } = useTheme();
  return <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.hairline }]}>
    <Text style={[styles.heading, { color: c.textPrimary }]}>{title}</Text>
    {children}
  </View>;
}

function Note({ children, selectable, error }) {
  const { c } = useTheme();
  return <Text
    accessibilityRole={error ? "alert" : undefined}
    selectable={selectable}
    style={{ color: error ? c.rose : c.textSecondary }}
  >{children}</Text>;
}

function Toggle({ title, value, onChange }) {
  const { c } = useTheme();
  return <View style={styles.toggle}>
    <Text style={{ color: c.textPrimary }}>{title}</Text>
    <Switch accessibilityLabel={title} value={value} onValueChange={onChange} />
  </View>;
}

function BrandChoice({ label, selected, disabled, swatch, onPress, role = "button" }) {
  const { c } = useTheme();
  return <Pressable accessibilityRole={role} accessibilityState={{ selected, disabled }} disabled={disabled}
    onPress={onPress} style={[styles.brandChoice, {
      borderColor: selected ? c.mint : c.hairline,
      backgroundColor: selected ? c.surfaceSunken : c.surface,
    }]}>
    {swatch && <View style={[styles.swatch, { backgroundColor: swatch }]} />}
    <Text style={{ color: selected ? c.mint : c.textPrimary, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
}

function StoreAppearance({ draft, setDraft, disabled }) {
  const accent = isStoreColor(draft.accent_color) ? draft.accent_color : defaultBranding.accent_color;
  const dark = draft.theme === "dark";
  const icon = storeIcons.find((option) => option.key === draft.store_icon);
  const previewText = dark ? "#F3F3FF" : "#17182D";

  return <Panel title="Store appearance">
    <Note>Template</Note>
    <View style={styles.templateOptions}>
      {storeTemplates.map(({ key, label, summary }) => <BrandChoice key={key} label={`${label} · ${summary}`} disabled={disabled}
        selected={draft.template === key} onPress={() => setDraft({ ...draft, template: key })} />)}
    </View>
    <Note>Theme</Note>
    <View style={styles.row}>
      {storeThemes.map(({ key, label }) => <BrandChoice key={key} label={label} disabled={disabled}
        selected={draft.theme === key} onPress={() => setDraft({ ...draft, theme: key })} />)}
    </View>
    <Note>Accent color</Note>
    <View style={styles.row}>
      {storeColors.map(({ label, value }) => <BrandChoice key={value} label={label} swatch={value} disabled={disabled}
        selected={draft.accent_color.toUpperCase() === value} onPress={() => setDraft({ ...draft, accent_color: value })} />)}
    </View>
    <Field label="Custom hex color" value={draft.accent_color} maxLength={7} editable={!disabled}
      autoCapitalize="characters" autoCorrect={false} onChangeText={(accent_color) => setDraft({ ...draft, accent_color })} />
    <Note>Store icon</Note>
    <View style={styles.row}>
      {storeIcons.map(({ key, label, symbol }) => <BrandChoice key={key} label={`${symbol} ${label}`} disabled={disabled}
        selected={draft.store_icon === key} onPress={() => setDraft({ ...draft, store_icon: key })} />)}
    </View>
    <Field label="Welcome message" value={draft.welcome_text} maxLength={180} editable={!disabled} multiline
      placeholder="Welcome to my data store" onChangeText={(welcome_text) => setDraft({ ...draft, welcome_text })} />
    <Field label="Store image URL" value={draft.image_url} maxLength={500} editable={!disabled}
      keyboardType="url" autoCapitalize="none" autoCorrect={false} placeholder="https://example.com/store.jpg"
      onChangeText={(image_url) => setDraft({ ...draft, image_url })} />
    <Note>Use a publicly accessible HTTPS image.</Note>
    <Note>Preview</Note>
    <View style={[styles.appearancePreview, { backgroundColor: dark ? "#141526" : "#F7F7FF", borderTopColor: accent }]}>
      {!!safeStoreUrl(draft.image_url) && <Image source={{ uri: safeStoreUrl(draft.image_url) }}
        resizeMode="cover" accessibilityLabel="Store image preview" style={styles.storeImage} />}
      <Text accessibilityElementsHidden style={styles.previewIcon}>{icon?.symbol}</Text>
      <Text style={[styles.heading, { color: previewText }]}>{draft.name.trim() || "Your store name"}</Text>
      {!!draft.welcome_text.trim() && <Text style={{ color: previewText }}>{draft.welcome_text}</Text>}
      <View style={[styles.previewBundles, draft.template === "list" && styles.previewList]}>
        {[0, 1, 2].map((item) => <View key={item} accessible={false} style={[styles.previewBundle, {
          backgroundColor: dark ? "#323347" : "#DDDDEF", borderLeftColor: accent,
          borderLeftWidth: draft.template === "showcase" ? 4 : 0,
          height: draft.template === "list" ? 12 : 24,
          flex: draft.template === "list" ? undefined : 1,
        }]} />)}
      </View>
    </View>
  </Panel>;
}

function StoreContacts({ draft, setDraft, disabled }) {
  return <Panel title="Public contacts">
    <Note>Customers see the contact details you fill in on your storefront.</Note>
    {storeContacts.map(({ key, label, placeholder, keyboardType }) => <Field
      key={key} label={label} placeholder={placeholder} keyboardType={keyboardType ?? "url"}
      editable={!disabled} value={draft[key]} autoCapitalize="none" autoCorrect={false}
      maxLength={key === "whatsapp" ? 24 : key === "contact_email" ? 254 : 500}
      onChangeText={(value) => setDraft({ ...draft, [key]: value })} />)}
  </Panel>;
}

function bundleLabel(item) {
  return `${item.network} · ${item.bundle}`;
}

function pricedLabel(item) {
  return `${bundleLabel(item)} · GH₵${pesewasToCedis(item.price_pesewas)}`;
}

function replaceRow(rows, updated) {
  return rows.some((row) => row.id === updated.id)
    ? rows.map((row) => row.id === updated.id ? updated : row)
    : [...rows, updated];
}

function PricingTiers({ tiers, items, saving, onSaveTier, onSaveItem }) {
  const [tier, setTier] = useState(null);
  const [item, setItem] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [search, setSearch] = useState("");

  const tierItems = items.filter((row) => row.tier_id === tier?.id);
  const usedKeys = new Set(tierItems.map((row) => row.catalog_key));
  const choices = (catalog ?? []).filter((pkg) =>
    !usedKeys.has(pkg.catalog_key) && bundleLabel(pkg).toLowerCase().includes(search.trim().toLowerCase()),
  );

  async function fetchCatalog() {
    setLoadingCatalog(true);
    try {
      setCatalog(await loadTierCatalog());
    } catch {
      setCatalog([]);
    } finally {
      setLoadingCatalog(false);
    }
  }

  function selectTier(next) {
    if (saving) return;
    setTier(next);
    setItem(null);
  }

  async function saveTier() {
    const updated = await onSaveTier(tier);
    if (updated) setTier(updated);
  }

  async function saveItem() {
    const updated = await onSaveItem(tier.id, item);
    if (updated) setItem(null);
  }

  return <Panel title="Pricing tiers">
    <Note>Create a tier and price bundles from the Mysti catalog. Price changes apply to every storefront offer using that bundle.</Note>
    <View style={styles.row}>
      <SecondaryButton title="New tier" icon="add-outline" onPress={() => selectTier(emptyTier)} />
      {tiers.map((row) => <SecondaryButton key={row.id} title={row.active ? row.name : `${row.name} (archived)`}
        onPress={() => selectTier(row)} />)}
    </View>
    {tier && <Panel title={tier.id ? "Edit tier" : "Create tier"}>
      <Field label="Tier name" value={tier.name} maxLength={60} editable={!saving}
        onChangeText={(name) => setTier({ ...tier, name })} />
      <Toggle title="Active tier" value={tier.active}
        onChange={(active) => { if (!saving) setTier({ ...tier, active }); }} />
      <Note>Archiving a tier hides its storefront offers.</Note>
      <PrimaryButton title={tier.id ? "Save tier" : "Create tier"} loading={saving === "tier"} disabled={Boolean(saving)} onPress={saveTier} />
      {tier.id && <>
        {!item && <SecondaryButton title="Price a catalog bundle" icon="add-outline" onPress={() => {
          if (saving) return;
          setItem(emptyItem);
          setSearch("");
          if (!catalog?.length && !loadingCatalog) fetchCatalog();
        }} />}
        {item && <Panel title={item.id ? "Edit bundle price" : "Price a bundle"}>
          {item.id || item.package ? <Note>{bundleLabel(item.package ?? item)}</Note> : <>
            <Field label="Find a bundle" value={search} onChangeText={setSearch} />
            {loadingCatalog ? <ActivityIndicator /> : <>
              {!catalog?.length && <SecondaryButton title="Retry loading catalog" onPress={fetchCatalog} />}
              {!!catalog?.length && choices.length === 0 && <Note>No available bundles match.</Note>}
              {choices.slice(0, 12).map((pkg) => <SecondaryButton key={pkg.catalog_key}
                title={`${bundleLabel(pkg)} · ${getProviderDisplayName(pkg.catalog_key.split(":")[0])}`}
                onPress={() => setItem({ ...item, package: pkg })} />)}
              {choices.length > 12 && <Note>Search to narrow the bundle list.</Note>}
            </>}
          </>}
          <Field label="Retail price (GH₵)" value={item.price} maxLength={9} editable={!saving}
            keyboardType="decimal-pad" onChangeText={(price) => setItem({ ...item, price })} />
          <Toggle title="Available in this tier" value={item.active}
            onChange={(active) => { if (!saving) setItem({ ...item, active }); }} />
          <View style={styles.row}>
            <PrimaryButton title="Save price" loading={saving === "price"} disabled={Boolean(saving) || !(item.id || item.package)} onPress={saveItem} />
            <SecondaryButton title="Cancel" onPress={() => { if (!saving) setItem(null); }} />
          </View>
        </Panel>}
        {tierItems.map((row) => <SecondaryButton key={row.id}
          title={`${pricedLabel(row)}${row.active ? "" : " · Hidden"}`}
          onPress={() => { if (!saving) setItem({ ...row, price: pesewasToCedis(row.price_pesewas) }); }} />)}
      </>}
    </Panel>}
  </Panel>;
}

function GuestOrders({ ownerId }) {
  const { showError, showSuccess } = useNotification();
  const [orders, setOrders] = useState([]);
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [saving, setSaving] = useState(false);
  const resolving = useRef(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(false);
    loadStoreOrders(ownerId, page).then((rows) => {
      if (active) setOrders(rows);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [ownerId, page, reload]));

  async function resolve() {
    if (!confirmation || resolving.current) return;
    resolving.current = true;
    setSaving(true);
    try {
      const updated = await resolveStoreOrder(ownerId, confirmation.order.id, confirmation.status);
      if (updated) {
        setOrders((rows) => rows.map((row) => row.id === updated.id ? { ...row, status: updated.status } : row));
        showSuccess("Order updated", statuses[updated.status]);
      } else {
        setReload((value) => value + 1);
        showError("Order changed", "This order may have already been updated.");
      }
      setConfirmation(null);
    } catch {
      showError("Could not update order", "Try again in a moment.");
    } finally {
      resolving.current = false;
      setSaving(false);
    }
  }

  return <Panel title="Guest orders">
    <Note>Fulfill orders through your usual Mysti workflow, then update their status here.</Note>
    <SecondaryButton title="Refresh orders" icon="refresh-outline" onPress={() => setReload((value) => value + 1)} />
    {loading ? <ActivityIndicator /> : error ? <Note error>Could not load guest orders.</Note> : <>
      {orders.length === 0 && <Note>{page === 0 ? "No guest orders yet." : "No older orders."}</Note>}
      {orders.slice(0, orderPageSize).map((order) => <Panel key={order.id} title={`${order.network} · ${order.bundle}`}>
        <Note>GH₵{pesewasToCedis(order.price_pesewas)} · {statuses[order.status]}</Note>
        <Note selectable>{order.phone}</Note>
        <Note>{orderDate.format(new Date(order.created_at))}</Note>
        <Note selectable>Ref {order.id}</Note>
        {order.status === "pending" && <View style={styles.row}>
          <SecondaryButton title="Mark fulfilled" onPress={() => setConfirmation({ order, status: "fulfilled" })} />
          <SecondaryButton title="Decline" onPress={() => setConfirmation({ order, status: "declined" })} />
        </View>}
      </Panel>)}
      <View style={styles.row}>
        {page > 0 && <SecondaryButton title="Newer orders" onPress={() => setPage(page - 1)} />}
        {orders.length > orderPageSize && <SecondaryButton title="Older orders" onPress={() => setPage(page + 1)} />}
      </View>
    </>}
    <ConfirmDialog
      visible={Boolean(confirmation)}
      title={confirmation?.status === "fulfilled" ? "Mark order fulfilled?" : "Decline this order?"}
      message={confirmation ? `${confirmation.order.network} · ${confirmation.order.bundle} · ${confirmation.order.phone}` : ""}
      onConfirm={resolve}
      onCancel={() => setConfirmation(null)}
      confirming={saving}
    />
  </Panel>;
}

function StoreEditor({ ownerId, tierManagement = false, openTiers }) {
  const { showError, showSuccess } = useNotification();
  const [store, setStore] = useState(null);
  const [draft, setDraft] = useState(emptyStore);
  const [tiers, setTiers] = useState([]);
  const [items, setItems] = useState([]);
  const [choices, setChoices] = useState([]);
  const [tierChoice, setTierChoice] = useState("");
  const [request, setRequest] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState("Store");
  const writeInFlight = useRef(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    setError(false);
    loadStorefront(ownerId).then((data) => {
      if (!active) return;
      setStore(data.store);
      setDraft(data.store ?? emptyStore);
      setTiers(data.tiers);
      setItems(data.items);
      setChoices(data.choices);
      setTierChoice(selectedStoreTier(data.store));
      setReady(true);
    }).catch(() => {
      if (active) setError(true);
    });
    return () => { active = false; };
  }, [ownerId, request]));

  async function save(section, operation) {
    if (writeInFlight.current) return;
    writeInFlight.current = true;
    setSaving(section);
    try {
      return await operation();
    } catch (failure) {
      const duplicates = {
        store: "This link name is in use, or a storefront was just created. Refresh and try again.",
        tier: "You already have a tier with this name.",
        price: "This catalog bundle already has a price in this tier.",
      };
      const message = failure.code === "23505"
        ? duplicates[section]
        : failure.code === "23514" && section === "selection"
          ? "This tier is no longer available. Open Tier Management to check it."
          : failure instanceof Error ? failure.message : "Try again in a moment.";
      showError("Could not save changes", message);
    } finally {
      writeInFlight.current = false;
      setSaving(null);
    }
  }

  const saveSettings = () => save("store", async () => {
    const updated = await saveStorefront(ownerId, draft, Boolean(store));
    setStore(updated);
    setDraft(updated);
    showSuccess("Storefront saved", updated.published ? "Your storefront is published." : "Your storefront is unpublished.");
  });

  const saveSelection = () => save("selection", async () => {
    const updated = await saveStoreTierSelection(ownerId, tierChoice);
    setStore(updated);
    setTierChoice(selectedStoreTier(updated));
    showSuccess("Storefront tier saved", "Your store now uses this tier’s bundles and prices.");
  });

  const removeStore = () => save("delete", async () => {
    await deleteStorefront(ownerId);
    setStore(null);
    setDraft(emptyStore);
    setTierChoice("");
    setTiers([]);
    setItems([]);
    setChoices([]);
    setTab("Store");
    setConfirmDelete(false);
    setRequest((value) => value + 1);
    showSuccess("Storefront deleted", "Your storefront and guest orders were permanently removed.");
  });

  const saveTier = (values) => save("tier", async () => {
    const updated = await saveStoreTier(ownerId, values);
    setTiers((rows) => replaceRow(rows, updated));
    return updated;
  });

  const savePrice = (tierId, values) => save("price", async () => {
    const updated = await saveTierItem(ownerId, tierId, values);
    setItems((rows) => replaceRow(rows, updated));
    return updated;
  });

  const link = store?.published ? storeLink(store.slug) : null;

  async function copyLink() {
    if (await copyToClipboard(link)) {
      showSuccess("Link copied", "Share it with your customers.");
    } else {
      showError("Could not copy link", "You can select and copy the link shown on screen.");
    }
  }

  async function shareLink() {
    try {
      await Share.share({ message: link });
    } catch {
      showError("Could not share link", "You can select and copy the link shown on screen.");
    }
  }

  if (!ready) {
    return error ? <Panel title="Storefront unavailable">
      <Note error>Could not load your storefront.</Note>
      <SecondaryButton title="Retry" onPress={() => setRequest((value) => value + 1)} />
    </Panel> : <ActivityIndicator />;
  }

  if (tierManagement) {
    return store
      ? <PricingTiers tiers={tiers} items={items} saving={saving} onSaveTier={saveTier} onSaveItem={savePrice} />
      : <Panel title="Set up your store">
          <Note>Save your storefront before creating tiers.</Note>
          <SecondaryButton title="Open storefront settings" onPress={openTiers} />
        </Panel>;
  }

  const tabs = store?.deleted_at ? ["Store", "Orders"]
    : store ? ["Store", "Appearance", "Contacts", "Pricing", "Orders"]
      : ["Store", "Appearance", "Contacts"];
  const activeTab = tabs.includes(tab) ? tab : "Store";
  const saveButton = <PrimaryButton title="Save storefront" onPress={saveSettings}
    loading={saving === "store"} disabled={Boolean(saving)} />;

  return <>
    {error && <Note error>Could not refresh your storefront. Showing the last loaded settings.</Note>}
    <View style={styles.row} accessibilityRole="tablist">
      {tabs.map((label) => <BrandChoice key={label} label={label} role="tab" selected={activeTab === label}
        disabled={Boolean(saving)} onPress={() => setTab(label)} />)}
    </View>
    {activeTab === "Store" && !store?.deleted_at && <Panel title="Store settings">
      <Field label="Display name" value={draft.name} maxLength={80} editable={!saving}
        onChangeText={(name) => setDraft({ ...draft, name })} />
      <Field label="Link name" value={draft.slug} maxLength={48} editable={!saving}
        autoCapitalize="none" autoCorrect={false} placeholder="ama-data"
        onChangeText={(slug) => setDraft({ ...draft, slug })} />
      <Note>Changing the link name replaces the old link.</Note>
      <Toggle title="Publish store" value={draft.published}
        onChange={(published) => { if (!saving) setDraft({ ...draft, published }); }} />
      {saveButton}
      {link && <>
        <Note selectable>{link}</Note>
        <View style={styles.row}>
          <SecondaryButton title="Copy link" icon="copy-outline" onPress={copyLink} />
          {Platform.OS !== "web" && <SecondaryButton title="Share link" icon="share-outline" onPress={shareLink} />}
          <SecondaryButton title="Open store" icon="open-outline" onPress={() => {
            Linking.openURL(link).catch(() => showError("Could not open storefront", "Try opening the displayed link in your browser."));
          }} />
        </View>
      </>}
    </Panel>}
    {activeTab === "Appearance" && <>
      <StoreAppearance draft={draft} setDraft={setDraft} disabled={Boolean(saving)} />
      {saveButton}
    </>}
    {activeTab === "Contacts" && <>
      <StoreContacts draft={draft} setDraft={setDraft} disabled={Boolean(saving)} />
      {saveButton}
    </>}
    {activeTab === "Pricing" && store && !store.deleted_at && <>
      <Panel title="Storefront pricing tier">
        <Note>Your storefront uses every available bundle and price in the tier you save.</Note>
        {!!selectedStoreTier(store) && <Note>
          {choices.find((tier) => tier.tier_key === selectedStoreTier(store))?.name ?? "The saved tier is unavailable."}
        </Note>}
        {choices.length === 0 && <Note>Create or activate a tier in Tier Management.</Note>}
        <View style={styles.row}>
          {choices.map((tier) => <SecondaryButton key={tier.tier_key} title={tier.name}
            icon={tier.tier_key === tierChoice ? "checkmark-outline" : undefined}
            onPress={() => { if (!saving) setTierChoice(tier.tier_key); }} />)}
        </View>
        <PrimaryButton title="Save tier" onPress={saveSelection} loading={saving === "selection"}
          disabled={Boolean(saving) || !choices.some((tier) => tier.tier_key === tierChoice) || tierChoice === selectedStoreTier(store)} />
        <SecondaryButton title="Tier management" icon="layers-outline" onPress={openTiers} />
      </Panel>
    </>}
    {activeTab === "Orders" && store && <GuestOrders ownerId={ownerId} />}
    {activeTab === "Store" && store && <Panel title="Delete storefront">
      <Note>Permanently remove your storefront, its listings, and its guest orders.</Note>
      <SecondaryButton title="Delete storefront" icon="trash-outline"
        onPress={() => { if (!saving) setConfirmDelete(true); }} />
    </Panel>}
    <ConfirmDialog visible={confirmDelete} title="Delete storefront?" icon="trash-outline" tone="danger"
      message="This permanently deletes your storefront, its listings, any storefront-only tiers, and its guest order history. The public link stops working."
      confirmText="Delete permanently" onConfirm={removeStore}
      confirming={saving === "delete"} onCancel={() => setConfirmDelete(false)} />
  </>;
}

export function AgentTierManagementScreen({ navigation }) {
  return <StorefrontScreen navigation={navigation} tierManagement />;
}

export default function StorefrontScreen({ navigation, tierManagement = false }) {
  const { profile, isSubAgent, isSuperAgent, loading } = useProfile();
  const bottomPadding = useDockBottomPadding(24);
  const canManage = (isSubAgent || (isSuperAgent && !tierManagement)) && Boolean(profile?.id);

  function back() {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace("Profile");
  }

  function openTiers() {
    if (tierManagement) navigation.navigate("Storefront");
    else if (isSuperAgent) navigation.navigate("SuperAgentPricing", { tab: "tiers" });
    else navigation.navigate("AgentTierManagement");
  }

  return <ThemedScreen>
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <ScreenHeader title={tierManagement ? "Tier Management" : "Storefront"}
        subtitle={tierManagement ? "Create tiers and price catalog bundles" : "Store link, retail prices and guest orders"} onBack={back} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]}>
        {loading ? <ActivityIndicator /> : canManage
          ? <StoreEditor key={profile.id} ownerId={profile.id}
              tierManagement={tierManagement} openTiers={openTiers} />
          : <Note>{tierManagement ? "Agent Tier Management requires an agent account." : "Storefront management is available to Mysti agents and super agents."}</Note>}
      </ScrollView>
    </SafeAreaView>
  </ThemedScreen>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 12, gap: 16, width: "100%", maxWidth: 740, alignSelf: "center" },
  panel: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 12 },
  heading: { fontSize: 17, fontWeight: "700" },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  toggle: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  brandChoice: { minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 6 },
  templateOptions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  storeImage: { width: "100%", height: 120, borderRadius: 8 },
  swatch: { width: 16, height: 16, borderRadius: 8 },
  appearancePreview: { borderTopWidth: 4, borderRadius: 12, padding: 14, gap: 7 },
  previewIcon: { fontSize: 25 },
  previewBundles: { flexDirection: "row", gap: 7, marginTop: 6 },
  previewList: { flexDirection: "column" },
  previewBundle: { borderRadius: 4 },
});
