import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  KeyboardAwareScrollView,
  KeyboardAvoidingView,
} from "react-native-keyboard-controller";

import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import { fonts } from "../components/theme";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";
import {
  invokeEdgeFunction,
  getEdgeFunctionErrorMessage,
} from "../lib/edgeFunctions";
import { getEdgeFunctionName } from "../lib/env";

export default function SuperAgentPaystackScreen({ navigation }) {
  const { showError, showSuccess } = useNotification();
  const theme = useTheme();
  const c = theme.c;
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = usePaystackStyles(c, topInset);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subaccount, setSubaccount] = useState(null);
  const [verificationStatus, setVerificationStatus] = useState(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let mounted = true;

    const loadData = async () => {
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
            "Paystack Sub-Account is not included in the Pro badge.",
          );
          navigation.replace("Home");
          return;
        }

        // Fetch banks first
        await fetchBanks();

        // Then fetch existing sub-account
        await fetchSubaccount(user.id);
        await fetchVerification();
      } catch (error) {
        console.error("Error loading Paystack screen:", error);
        showError("Error", "Unable to load Paystack settings right now.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadData();

    return () => {
      mounted = false;
    };
  }, [navigation, showError]);

  // Pull-to-refresh handler
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await fetchSubaccount(user.id);
        await fetchVerification();
      }
    } catch (error) {
      showError("Error", "Failed to refresh data.");
    } finally {
      setRefreshing(false);
    }
  };

  const [banks, setBanks] = useState([]);
  const [mobileMoneyProviders, setMobileMoneyProviders] = useState([]);
  const [banksLoading, setBanksLoading] = useState(false);
  // Fetch verification status from Paystack
  const fetchVerification = async () => {
    try {
      const { data, error } = await invokeEdgeFunction("paystack-subaccount", {
        body: { action: "verifySubaccount" },
      });
      if (error) throw error;
      if (data?.subaccount) {
        setSubaccount(data.subaccount);
        const isActive = data.paystack_status === "active";
        setVerificationStatus({
          verified: isActive,
          paystack_status: data.paystack_status || "unknown",
          timestamp: data.timestamp,
        });
      } else {
        setVerificationStatus({
          verified: false,
          paystack_status: null,
          message: data.message || "No sub-account",
        });
      }
    } catch (err) {
      // supabase-js puts the real reason on err.context (a Response), NOT on
      // err.message. Logging the error object alone prints
      // "[FunctionsHttpError: Edge Function returned a non-2xx status code]"
      // for every distinct failure, which hid a 403 badge rejection behind
      // what looked like a generic outage.
      const detail = await getEdgeFunctionErrorMessage(
        err,
        "Unknown edge function error",
      );
      console.error(
        "Failed to verify subaccount (" +
          getEdgeFunctionName("paystack-subaccount") +
          "): " +
          detail,
      );
      setVerificationStatus({
        verified: false,
        message: "Verification failed",
      });
    }
  };

  const fetchBanks = async () => {
    setBanksLoading(true);
    try {
      const { data, error } = await invokeEdgeFunction("paystack-subaccount", {
        body: { action: "listBanks" },
      });
      if (error) throw error;
      const rawBanks = data?.banks || [];

      // Merge duplicates by code + lowercase name (like ExpressMart normalizeBanks)
      const seen = new Set();
      const uniqueBanks = [];
      for (const b of rawBanks) {
        if (!b || b.active === false || b.is_deleted === true) continue;
        const code = String(b.code || "").trim();
        const name = String(b.name || "").trim();
        if (!code || !name) continue;
        const key = `${code}:${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueBanks.push({ ...b, code, name });
      }

      // Split into bank and mobile money (like ExpressMart)
      const providerAliasMap = {
        mtn: "mtn",
        airteltigo: "airtel",
        telecel: "telecel",
        vodafone: "telecel",
        vod: "telecel",
      };
      const banksOnly = [];
      const mobileOnly = [];
      for (const b of uniqueBanks) {
        const nameLower = b.name.toLowerCase();
        const codeLower = b.code.toLowerCase();
        const isMobile =
          nameLower.includes("mtn") ||
          nameLower.includes("airtel") ||
          nameLower.includes("telecel") ||
          nameLower.includes("vodafone") ||
          nameLower.includes("vod") ||
          codeLower === "mtn" ||
          codeLower === "airtel" ||
          codeLower === "telecel" ||
          codeLower === "vodafone" ||
          codeLower === "vod";
        if (isMobile) {
          mobileOnly.push(b);
        } else {
          banksOnly.push(b);
        }
      }

      setBanks(banksOnly);
      setMobileMoneyProviders(mobileOnly);
    } catch (err) {
      const detail = await getEdgeFunctionErrorMessage(
        err,
        "Unknown edge function error",
      );
      console.error(
        "Failed to fetch banks (" +
          getEdgeFunctionName("paystack-subaccount") +
          "): " +
          detail,
      );
    } finally {
      setBanksLoading(false);
    }
  };

  useEffect(() => {
    fetchBanks();
  }, []);

  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [showBankPicker, setShowBankPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [showForm, setShowForm] = useState(true);
  const [form, setForm] = useState({
    business_name: "",
    settlement_type: "bank",
    settlement_bank_code: "",
    settlement_bank_name: "",
    account_number: "",
    percentage_charge: "1.95",
    description: "",
  });

  // Fetch existing sub-account from backend
  const fetchSubaccount = async (userId) => {
    try {
      const { data, error } = await invokeEdgeFunction("paystack-subaccount", {
        body: { action: "getSubaccount" },
      });
      if (error) throw error;
      if (data?.subaccount) {
        setSubaccount(data.subaccount);
        setShowForm(false);
        setForm({
          business_name: data.subaccount.business_name || "",
          settlement_type: data.subaccount.settlement_bank_code
            ? "bank"
            : "mobile_money",
          settlement_bank_code: data.subaccount.settlement_bank_code || "",
          settlement_bank_name: data.subaccount.settlement_bank || "",
          account_number: data.subaccount.account_number || "",
          percentage_charge: String(data.subaccount.percentage_charge ?? 1.95),
          description: data.subaccount.description || "",
        });
      } else {
        setShowForm(true);
      }
    } catch (err) {
      const detail = await getEdgeFunctionErrorMessage(
        err,
        "Unknown edge function error",
      );
      console.error(
        "Failed to fetch subaccount (" +
          getEdgeFunctionName("paystack-subaccount") +
          "): " +
          detail,
      );
      if (err.message?.includes("migration_required")) {
        showError(
          "Setup Required",
          "Please contact support to complete the database setup.",
        );
      }
    }
  };

  const validateForm = () => {
    const errors = {};
    if (!form.business_name.trim())
      errors.business_name = "Business name is required";
    if (!form.settlement_bank_code.trim())
      errors.settlement_bank = "Please select a bank/provider";
    if (!form.account_number.trim())
      errors.account_number = "Account number is required";
    else if (!/^\d+$/.test(form.account_number.trim()))
      errors.account_number = "Account number must contain only digits";
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Handle create or update sub-account
  const handleSaveSubaccount = async () => {
    if (!validateForm()) return;
    try {
      if (subaccount) {
        setUpdating(true);
        const { data, error } = await invokeEdgeFunction(
          "paystack-subaccount",
          {
            body: {
              action: "updateSubaccount",
              subaccount: {
                business_name: form.business_name.trim(),
                settlement_bank_code: form.settlement_bank_code.trim(),
                account_number: form.account_number.trim(),
                percentage_charge: 1.95,
                description: form.description.trim() || null,
              },
            },
          },
        );
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        showSuccess("Updated", "Sub-account details updated successfully.");
        setEditMode(false);
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) await fetchSubaccount(user.id);
      } else {
        setCreating(true);
        const { data, error } = await invokeEdgeFunction(
          "paystack-subaccount",
          {
            body: {
              action: "createSubaccount",
              subaccount: {
                business_name: form.business_name.trim(),
                settlement_bank_code: form.settlement_bank_code.trim(),
                account_number: form.account_number.trim(),
                percentage_charge: 1.95,
                description: form.description.trim() || null,
              },
            },
          },
        );
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        showSuccess("Created", "Paystack sub-account created successfully.");
        setEditMode(false);
        setShowForm(false);
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) await fetchSubaccount(user.id);
      }
    } catch (err) {
      console.error(
        "Sub-account operation error (" +
          getEdgeFunctionName("paystack-subaccount") +
          "):",
        err,
      );
      showError("Error", err.message || "Failed to save sub-account.");
    } finally {
      setCreating(false);
      setUpdating(false);
    }
  };

  // Verify sub-account with Paystack
  const handleVerifyPress = async () => {
    setVerifying(true);
    try {
      const { data, error } = await invokeEdgeFunction("paystack-subaccount", {
        body: { action: "verifySubaccount" },
      });
      if (error) throw error;
      if (data?.subaccount) {
        setSubaccount(data.subaccount);
        const isActive = data.paystack_status === "active";
        setVerificationStatus({
          verified: isActive,
          paystack_status: data.paystack_status || "unknown",
          timestamp: data.timestamp,
        });
        if (isActive) {
          showSuccess(
            "Verified",
            "Sub-account is verified and active on Paystack.",
          );
        } else {
          showSuccess(
            "Verified",
            "Sub-account is found but currently inactive on Paystack.",
          );
        }
      } else {
        setVerificationStatus({
          verified: false,
          paystack_status: null,
          message: data.message || "Not verified",
        });
      }
    } catch (err) {
      console.error(
        "Verification failed (" +
          getEdgeFunctionName("paystack-subaccount") +
          "):",
        err,
      );
      showError("Error", "Failed to verify sub-account with Paystack.");
      setVerificationStatus({
        verified: false,
        message: "Verification failed",
      });
    } finally {
      setVerifying(false);
    }
  };

  const handleToggleActive = async () => {
    if (!subaccount?.subaccount_code) {
      showError("Error", "No sub-account configured.");
      return;
    }
    try {
      const { data, error } = await invokeEdgeFunction("paystack-subaccount", {
        body: {
          action: "updateSubaccount",
          subaccount: { active: !subaccount.is_active },
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const ns = !subaccount.is_active;
      showSuccess(
        "Updated",
        "Sub-account is now " + (ns ? "active" : "inactive") + ".",
      );
      setSubaccount({ ...subaccount, is_active: ns });
    } catch (err) {
      console.error(
        "Toggle active error (" +
          getEdgeFunctionName("paystack-subaccount") +
          "):",
        err,
      );
      showError("Error", err.message || "Failed to update status.");
    }
  };

  const handleDeleteSubaccount = async () => {
    Alert.alert(
      "Delete Sub-Account",
      "Are you sure? This will prevent payments from being routed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await invokeEdgeFunction("paystack-subaccount", {
                body: {
                  action: "updateSubaccount",
                  subaccount: {
                    business_name: "",
                    settlement_bank_code: "",
                    account_number: "",
                    percentage_charge: 0,
                    active: false,
                  },
                },
              });
              showSuccess("Deleted", "Sub-account has been removed.");
              setSubaccount(null);
              setForm({
                business_name: "",
                settlement_type: "bank",
                settlement_bank_code: "",
                settlement_bank_name: "",
                account_number: "",
                percentage_charge: "1.95",
                description: "",
              });
            } catch (err) {
              console.error(
                "Delete error (" +
                  getEdgeFunctionName("paystack-subaccount") +
                  "):",
                err,
              );
              showError(
                "Error",
                err.message || "Failed to delete sub-account.",
              );
            }
          },
        },
      ],
    );
  };

  // Filtered banks for search
  const displayedBanks =
    form.settlement_type === "bank"
      ? banks.filter(
          (b) =>
            b.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            b.code.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : mobileMoneyProviders.filter(
          (p) =>
            p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            p.code.toLowerCase().includes(searchQuery.toLowerCase()),
        );

  // Legacy alias
  const handleCreateSubaccount = handleSaveSubaccount;

  if (loading) {
    return (
      <ThemedScreen style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={c.mint} />
          <Text style={styles.loadingText}>Loading Paystack settings...</Text>
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
        <View style={styles.headerCenter}>
          <Text style={styles.title}>Paystack Settings</Text>
          <Text style={styles.subtitle}>
            Manage your payment settlement account
          </Text>
        </View>
        {subaccount && (
          <TouchableOpacity
            onPress={handleToggleActive}
            style={[
              styles.statusBadge,
              subaccount.is_active
                ? styles.statusBadgeActive
                : styles.statusBadgeInactive,
            ]}
          >
            <Ionicons
              name={subaccount.is_active ? "checkmark-circle" : "close-circle"}
              size={18}
              color={c.onAccent}
            />
            <Text
              style={[
                styles.statusText,
                !subaccount.is_active && styles.statusTextInactive,
              ]}
            >
              {subaccount.is_active ? "Active" : "Inactive"}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        keyboardShouldPersistTaps="handled"
      >
        {/* Summary Card */}
        {subaccount && !editMode && (
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeader}>
              <Ionicons name="card-outline" size={24} color={c.mintDim} />
              <Text style={styles.summaryTitle}>Settlement Account</Text>
            </View>
            <View style={styles.verifySection}>
              <View style={styles.verifyInfo}>
                {verificationStatus?.paystack_status === null ? (
                  <Ionicons
                    name="shield-outline"
                    size={16}
                    color={c.textMuted}
                  />
                ) : verificationStatus?.verified ? (
                  <Ionicons name="shield-checkmark" size={16} color={c.mint} />
                ) : (
                  <Ionicons name="shield-alert" size={16} color={c.amber} />
                )}
                <Text style={styles.verifyLabel}>
                  {verificationStatus?.paystack_status === null
                    ? "No sub-account configured"
                    : verificationStatus?.verified
                      ? "Active ✓"
                      : `Account - ${verificationStatus.paystack_status}`}
                </Text>
              </View>
              <TouchableOpacity
                style={[
                  styles.verifyButton,
                  verificationStatus?.verified
                    ? styles.verifyButtonVerified
                    : verificationStatus?.paystack_status === null
                      ? styles.verifyButtonNeutral
                      : styles.verifyButtonInactive,
                ]}
                onPress={handleVerifyPress}
                disabled={verifying}
              >
                {verifying ? (
                  <ActivityIndicator size="small" color={c.mint} />
                ) : (
                  <>
                    <Ionicons
                      name="checkmark-done"
                      size={16}
                      color={
                        verificationStatus?.verified ? c.mint : c.textSecondary
                      }
                    />
                    <Text
                      style={[
                        styles.verifyButtonText,
                        verificationStatus?.verified &&
                          styles.verifyButtonVerifiedText,
                        !verificationStatus?.verified &&
                          verificationStatus?.paystack_status !== null &&
                          styles.verifyButtonInactiveText,
                      ]}
                    >
                      Check
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Business Name</Text>
              <Text style={styles.infoValue}>
                {subaccount.business_name || "\u2014"}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Bank / Provider</Text>
              <Text style={styles.infoValue}>
                {subaccount.settlement_bank ||
                  subaccount.settlement_bank_code ||
                  "\u2014"}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Account Number</Text>
              <Text style={styles.infoValue}>
                {subaccount.account_number || "\u2014"}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Percentage Charge</Text>
              <Text style={styles.infoValue}>
                {subaccount.percentage_charge != null
                  ? `${subaccount.percentage_charge}%`
                  : "\u2014"}
              </Text>
            </View>
            {subaccount.description && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Description</Text>
                <Text style={styles.infoValue}>{subaccount.description}</Text>
              </View>
            )}
            <View style={styles.summaryActions}>
              <TouchableOpacity
                style={styles.actionEditButton}
                onPress={() => setEditMode(true)}
              >
                <Ionicons name="pencil" size={18} color={c.mintDim} />
                <Text style={styles.actionEditText}>Edit Details</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionDeleteButton}
                onPress={handleDeleteSubaccount}
              >
                <Ionicons name="trash-outline" size={18} color={c.rose} />
                <Text style={styles.actionDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {(showForm || editMode || !subaccount) && (
          <View style={styles.formCard}>
            <View style={styles.formHeader}>
              <Ionicons
                name={editMode ? "pencil" : "add-circle-outline"}
                size={24}
                color={c.mint}
              />
              <Text style={styles.formTitle}>
                {editMode ? "Edit Sub-Account" : "Configure Settlement Account"}
              </Text>
            </View>
            <Text style={styles.formDescription}>
              {editMode
                ? "Update your Paystack settlement sub-account details below."
                : subaccount
                  ? "You have a settlement account. Edit above or make changes here."
                  : "Link a Paystack settlement sub-account for super-agent payouts."}
            </Text>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Business Name *</Text>
              <TextInput
                style={[
                  styles.input,
                  formErrors.business_name && styles.inputError,
                ]}
                value={form.business_name}
                onChangeText={(t) => {
                  setForm({ ...form, business_name: t });
                  if (formErrors.business_name)
                    setFormErrors({ ...formErrors, business_name: null });
                }}
                placeholder="e.g. Mysti Digital Services"
                editable={!creating && !updating}
              />
              {formErrors.business_name && (
                <Text style={styles.errorText}>{formErrors.business_name}</Text>
              )}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Settlement Type</Text>
              <View style={styles.toggleRow}>
                <TouchableOpacity
                  style={[
                    styles.toggleButton,
                    form.settlement_type === "bank" &&
                      styles.toggleButtonActive,
                  ]}
                  onPress={() =>
                    setForm({
                      ...form,
                      settlement_type: "bank",
                      settlement_bank_code: "",
                      settlement_bank_name: "",
                    })
                  }
                  disabled={creating || updating}
                >
                  <Ionicons
                    name="business"
                    size={18}
                    color={
                      form.settlement_type === "bank" ? c.onAccent : c.mintDim
                    }
                  />
                  <Text
                    style={[
                      styles.toggleButtonText,
                      form.settlement_type === "bank" &&
                        styles.toggleButtonTextActive,
                    ]}
                  >
                    Bank
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.toggleButton,
                    form.settlement_type === "mobile_money" &&
                      styles.toggleButtonActive,
                  ]}
                  onPress={() =>
                    setForm({
                      ...form,
                      settlement_type: "mobile_money",
                      settlement_bank_code: "",
                      settlement_bank_name: "",
                    })
                  }
                  disabled={creating || updating}
                >
                  <Ionicons
                    name="phone-portrait"
                    size={18}
                    color={
                      form.settlement_type === "mobile_money"
                        ? c.onAccent
                        : c.mintDim
                    }
                  />
                  <Text
                    style={[
                      styles.toggleButtonText,
                      form.settlement_type === "mobile_money" &&
                        styles.toggleButtonTextActive,
                    ]}
                  >
                    Mobile Money
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>
                {form.settlement_type === "bank"
                  ? "Bank *"
                  : "Mobile Money Provider *"}
              </Text>
              {banksLoading ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color={c.mintDim} />
                  <Text style={styles.loadingTextSmall}>
                    Loading options...
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[
                    styles.pickerInput,
                    formErrors.settlement_bank && styles.inputError,
                  ]}
                  onPress={() => {
                    if (!creating && !updating) setShowBankPicker(true);
                  }}
                  disabled={creating || updating}
                >
                  <View style={styles.pickerContent}>
                    {form.settlement_bank_name ? (
                      <>
                        <Text style={styles.pickerValue}>
                          {form.settlement_bank_name}
                        </Text>
                        <Text style={styles.pickerCode}>
                          ({form.settlement_bank_code})
                        </Text>
                      </>
                    ) : (
                      <Text style={styles.pickerPlaceholder}>
                        Tap to select{" "}
                        {form.settlement_type === "bank"
                          ? "a bank"
                          : "a provider"}
                        ...
                      </Text>
                    )}
                  </View>
                  <Ionicons name="chevron-down" size={20} color={c.textMuted} />
                </TouchableOpacity>
              )}
              {formErrors.settlement_bank && (
                <Text style={styles.errorText}>
                  {formErrors.settlement_bank}
                </Text>
              )}
              {!formErrors.settlement_bank &&
                !banksLoading &&
                ((form.settlement_type === "bank" && banks.length === 0) ||
                  (form.settlement_type !== "bank" &&
                    mobileMoneyProviders.length === 0)) && (
                  <Text style={styles.emptyStateText}>
                    No {form.settlement_type === "bank" ? "banks" : "providers"}{" "}
                    available.
                  </Text>
                )}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Account Number *</Text>
              <TextInput
                style={[
                  styles.input,
                  formErrors.account_number && styles.inputError,
                ]}
                value={form.account_number}
                onChangeText={(t) => {
                  setForm({ ...form, account_number: t });
                  if (formErrors.account_number)
                    setFormErrors({ ...formErrors, account_number: null });
                }}
                placeholder="Enter account number"
                keyboardType="numeric-pad"
                editable={!creating && !updating && !editMode}
              />
              {formErrors.account_number && (
                <Text style={styles.errorText}>
                  {formErrors.account_number}
                </Text>
              )}
            </View>

            <View style={styles.fieldGroup}>
              <View style={styles.chargeRow}>
                <Text style={styles.label}>Paystack Charge (%)</Text>
                <View style={styles.chargePreview}>
                  <Text style={styles.chargePreviewText}>1.95%</Text>
                </View>
              </View>
              <TextInput
                style={[styles.input, styles.chargeInput]}
                value="1.95"
                editable={false}
                placeholder="1.95"
                keyboardType="numeric-pad"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Description (optional)</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={form.description}
                onChangeText={(t) => setForm({ ...form, description: t })}
                placeholder="Note about this settlement account"
                multiline
                numberOfLines={3}
                editable={!creating && !updating}
                textAlignVertical="top"
              />
            </View>

            <View style={styles.buttonRow}>
              {editMode && (
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={() => {
                    setEditMode(false);
                    if (subaccount) {
                      setForm({
                        business_name: subaccount.business_name || "",
                        settlement_type: subaccount.settlement_bank_code
                          ? "bank"
                          : "mobile_money",
                        settlement_bank_code:
                          subaccount.settlement_bank_code || "",
                        settlement_bank_name: subaccount.settlement_bank || "",
                        account_number: subaccount.account_number || "",
                        percentage_charge: String(
                          subaccount.percentage_charge ?? 1.95,
                        ),
                        description: subaccount.description || "",
                      });
                    } else {
                      setForm({
                        business_name: "",
                        settlement_type: "bank",
                        settlement_bank_code: "",
                        settlement_bank_name: "",
                        account_number: "",
                        percentage_charge: "1.95",
                        description: "",
                      });
                    }
                    setFormErrors({});
                  }}
                  disabled={creating || updating}
                >
                  <Ionicons name="close" size={18} color={c.textPrimary} />
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[
                  styles.saveButton,
                  (creating || updating) && styles.saveButtonDisabled,
                ]}
                onPress={handleSaveSubaccount}
                disabled={creating || updating}
              >
                {creating || updating ? (
                  <ActivityIndicator size="small" color={c.onAccent} />
                ) : (
                  <>
                    <Ionicons
                      name={editMode ? "save-outline" : "checkmark-circle"}
                      size={20}
                      color={c.onAccent}
                    />
                    <Text style={styles.saveButtonText}>
                      {editMode
                        ? "Save Changes"
                        : subaccount
                          ? "Update Account"
                          : "Create and Save"}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Help Info Card */}
        <View style={styles.helpCard}>
          <Ionicons name="information-circle" size={20} color={c.mintDim} />
          <Text style={styles.helpText}>
            Your settlement account receives split payments from customer
            transactions. Ensure the account details are correct before saving.
          </Text>
        </View>
      </KeyboardAwareScrollView>

      {/* Bank Picker Modal */}
      <Modal
        visible={showBankPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBankPicker(false)}
      >
        <KeyboardAvoidingView style={styles.modalOverlay} behavior="padding">
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  Select{" "}
                  {form.settlement_type === "bank"
                    ? "Bank"
                    : "Mobile Money Provider"}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {displayedBanks.length} available
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowBankPicker(false)}
                style={styles.modalCloseButton}
              >
                <Ionicons name="close" size={22} color={c.textPrimary} />
              </TouchableOpacity>
            </View>
            {/* Search Bar */}
            <View style={styles.searchContainer}>
              <Ionicons name="search" size={20} color={c.textMuted} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search by name or code..."
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus
              />
              {searchQuery ? (
                <TouchableOpacity onPress={() => setSearchQuery("")}>
                  <Ionicons name="close-circle" size={18} color={c.textMuted} />
                </TouchableOpacity>
              ) : null}
            </View>
            <FlatList
              data={displayedBanks}
              keyExtractor={(item) => item.code}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.modalList}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.modalItem,
                    form.settlement_bank_code === item.code &&
                      styles.modalItemSelected,
                  ]}
                  onPress={() => {
                    setForm({
                      ...form,
                      settlement_bank_code: item.code,
                      settlement_bank_name: item.name,
                    });
                    setShowBankPicker(false);
                    setSearchQuery("");
                  }}
                >
                  <View style={styles.modalItemContent}>
                    <View
                      style={[
                        styles.modalItemIcon,
                        form.settlement_bank_code === item.code
                          ? styles.modalItemIconSelected
                          : null,
                      ]}
                    >
                      <Ionicons
                        name={
                          form.settlement_type === "bank"
                            ? "business"
                            : "phone-portrait"
                        }
                        size={18}
                        color={
                          form.settlement_bank_code === item.code
                            ? c.onAccent
                            : c.mintDim
                        }
                      />
                    </View>
                    <View style={styles.modalItemTexts}>
                      <Text
                        style={[
                          styles.modalItemText,
                          form.settlement_bank_code === item.code &&
                            styles.modalItemTextSelected,
                        ]}
                      >
                        {item.name}
                      </Text>
                      <Text style={styles.modalItemCode}>
                        Code: {item.code}
                      </Text>
                    </View>
                  </View>
                  {form.settlement_bank_code === item.code && (
                    <Ionicons
                      name="checkmark-circle"
                      size={22}
                      color={c.mintDim}
                    />
                  )}
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <View style={styles.modalEmpty}>
                  <Ionicons name="close-circle" size={40} color={c.textMuted} />
                  <Text style={styles.modalEmptyText}>
                    {searchQuery ? "No results found" : "No items available"}
                  </Text>
                </View>
              }
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ThemedScreen>
  );
}
// Layered on the shared kit. Screen-specific parts are the settlement
// summary, the two-way settlement-type toggle, the bank picker modal, and the
// verification chips - each mapped onto semantic palette tones so the states
// stay distinguishable in both schemes.
const usePaystackStyles = (c, topInset = 0) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    ...base,
    safeArea: { ...base.screen },
    loadingContainer: { ...base.center },
    loadingText: { ...base.headerSubtitle, marginTop: 12, fontSize: 15 },

    header: { ...base.header, paddingTop: 18 + topInset, paddingBottom: 14 },
    backButton: { ...base.backButton, borderRadius: 999 },
    title: { ...base.headerTitle, fontSize: 20 },
    subtitle: { ...base.headerSubtitle },

    statusBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
    },
    statusBadgeActive: { backgroundColor: `${c.mint}26` },
    statusBadgeInactive: { backgroundColor: c.surfaceHover },
    statusText: { fontFamily: fonts.bodyBold, fontSize: 12, color: c.mint },
    statusTextInactive: { color: c.textMuted },

    content: { ...base.body, paddingTop: 20, paddingBottom: 40, gap: 20 },

    // Settlement summary
    summaryCard: { ...base.card, borderRadius: 22, padding: 18 },
    summaryHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginBottom: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.hairline,
    },
    summaryTitle: { ...base.sectionTitle, fontSize: 16, marginBottom: 0 },
    infoRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 8,
      gap: 16,
    },
    infoLabel: {
      ...base.rowSubtitle,
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      marginTop: 0,
    },
    infoValue: { ...base.rowValue, flex: 1, textAlign: "right" },
    summaryActions: {
      flexDirection: "row",
      gap: 12,
      marginTop: 16,
      paddingTop: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.hairline,
    },
    actionEditButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 12,
      backgroundColor: c.surfaceHover,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: `${c.mint}55`,
    },
    actionEditText: { fontFamily: fonts.bodyBold, fontSize: 13, color: c.mint },
    actionDeleteButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 12,
      backgroundColor: c.surfaceHover,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: `${c.rose}55`,
    },
    actionDeleteText: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.rose,
    },

    // Form card
    formCard: { ...base.card, borderRadius: 22, padding: 18 },
    formHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginBottom: 6,
    },
    formTitle: { ...base.sectionTitle, fontSize: 16, marginBottom: 0 },
    formDescription: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 20,
      marginBottom: 16,
    },
    fieldGroup: { marginBottom: 16 },
    label: { ...base.label, fontSize: 12.5 },
    input: {
      borderWidth: 1,
      borderColor: c.hairline,
      borderRadius: 16,
      padding: 13,
      fontFamily: fonts.body,
      fontSize: 14,
      backgroundColor: c.canvasRaised,
      color: c.textPrimary,
    },
    inputError: { borderColor: c.rose, backgroundColor: `${c.rose}14` },
    textArea: { minHeight: 80, textAlignVertical: "top" },
    errorText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.rose,
      marginTop: 4,
    },

    // Settlement-type toggle
    toggleRow: { flexDirection: "row", gap: 10 },
    toggleButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 13,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: c.hairline,
      borderRadius: 999,
      backgroundColor: c.surface,
    },
    toggleButtonActive: { borderColor: c.mint, backgroundColor: `${c.mint}14` },
    toggleButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 14,
      color: c.textSecondary,
    },
    toggleButtonTextActive: { color: c.mint },

    // Picker
    pickerInput: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderWidth: 1,
      borderColor: c.hairline,
      borderRadius: 16,
      padding: 13,
      backgroundColor: c.canvasRaised,
    },
    pickerContent: { flex: 1 },
    pickerValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.textPrimary,
    },
    pickerCode: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    pickerPlaceholder: {
      fontFamily: fonts.body,
      fontSize: 14,
      color: c.textMuted,
    },
    loadingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 12,
    },
    loadingTextSmall: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textMuted,
    },
    emptyStateText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.rose,
      marginTop: 4,
    },

    // Charge preview
    chargeRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    chargePreview: {
      backgroundColor: `${c.mint}1F`,
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 999,
    },
    chargePreviewText: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.mint,
    },

    // Buttons
    buttonRow: { flexDirection: "row", gap: 10, marginTop: 8 },
    cancelButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 15,
      backgroundColor: c.surface,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
    },
    cancelButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 14,
      color: c.textPrimary,
    },
    saveButton: {
      flex: 2,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 15,
      backgroundColor: c.mint,
      borderRadius: 999,
    },
    saveButtonDisabled: { opacity: 0.55 },
    saveButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 15,
      color: c.onAccent,
    },

    // Read-only computed charge
    chargeInput: { backgroundColor: c.surfaceHover, color: c.textMuted },

    helpCard: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      backgroundColor: `${c.sky}12`,
      borderRadius: 16,
      padding: 14,
      borderWidth: 1,
      borderColor: `${c.sky}33`,
    },
    helpText: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textSecondary,
      lineHeight: 18,
    },

    // Bank picker modal
    modalOverlay: {
      flex: 1,
      backgroundColor: c.menuBackdrop,
      justifyContent: "flex-end",
    },
    modalContent: {
      backgroundColor: c.canvasRaised,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      maxHeight: "80%",
      paddingBottom: 20,
      borderTopWidth: 1,
      borderColor: c.hairline,
    },
    modalHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.hairline,
    },
    modalTitle: {
      fontFamily: fonts.display,
      fontSize: 18,
      color: c.textPrimary,
    },
    modalSubtitle: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    modalCloseButton: {
      width: 32,
      height: 32,
      borderRadius: 999,
      backgroundColor: c.surfaceHover,
      justifyContent: "center",
      alignItems: "center",
    },

    searchContainer: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginHorizontal: 20,
      marginTop: 14,
      marginBottom: 10,
      paddingHorizontal: 12,
      paddingVertical: 11,
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    searchInput: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 14,
      color: c.textPrimary,
    },

    modalList: { paddingHorizontal: 20, paddingBottom: 20 },
    modalItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 14,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
      marginBottom: 6,
    },
    modalItemSelected: { borderColor: c.mint, backgroundColor: `${c.mint}14` },
    modalItemContent: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      flex: 1,
    },
    modalItemIcon: {
      width: 36,
      height: 36,
      borderRadius: 12,
      backgroundColor: c.surfaceHover,
      justifyContent: "center",
      alignItems: "center",
    },
    modalItemIconSelected: { backgroundColor: c.mint },
    modalItemTexts: { flex: 1 },
    modalItemText: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.textPrimary,
    },
    modalItemTextSelected: { color: c.mint },
    modalItemCode: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },

    verifySection: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 10,
      paddingHorizontal: 2,
      marginBottom: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.hairline,
    },
    verifyInfo: { flexDirection: "row", alignItems: "center", gap: 6 },
    verifyLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.textPrimary,
    },
    verifyButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: c.surfaceHover,
      borderRadius: 999,
      paddingVertical: 7,
      paddingHorizontal: 11,
    },
    verifyButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 12,
      color: c.textSecondary,
    },
    // Verification is a three-state signal, so each state gets its own tone
    // rather than sharing one neutral chip.
    verifyButtonVerified: { backgroundColor: `${c.mint}26` },
    verifyButtonVerifiedText: { color: c.mint },
    verifyButtonNeutral: { backgroundColor: c.surfaceHover },
    verifyButtonInactive: { backgroundColor: `${c.amber}26` },
    verifyButtonInactiveText: { color: c.amber },

    modalEmpty: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 40,
      gap: 10,
    },
    modalEmptyText: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.textMuted,
    },
  });
};
