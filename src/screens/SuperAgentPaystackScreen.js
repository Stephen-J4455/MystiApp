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
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import colors from "../components/theme";
import { getEdgeFunctionName } from "../lib/env";

export default function SuperAgentPaystackScreen({ navigation }) {
  const { showError, showSuccess } = useNotification();
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
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("paystack-subaccount"),
        { body: { action: "verifySubaccount" } },
      );
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
        setVerificationStatus({ verified: false, paystack_status: null, message: data.message || "No sub-account" });
      }
    } catch (err) {
      console.error("Failed to verify subaccount:", err);
      setVerificationStatus({ verified: false, message: "Verification failed" });
    }
  };

  const fetchBanks = async () => {
    setBanksLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("paystack-subaccount"),
        { body: { action: "listBanks" } },
      );
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
      console.error("Failed to fetch banks:", err);
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
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("paystack-subaccount"),
        { body: { action: "getSubaccount" } },
      );
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
          percentage_charge: String(
            data.subaccount.percentage_charge ?? 1.95,
          ),
          description: data.subaccount.description || "",
        });
      } else {
        setShowForm(true);
      }
    } catch (err) {
      console.error("Failed to fetch subaccount:", err);
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
        const { data, error } = await supabase.functions.invoke(
          getEdgeFunctionName("paystack-subaccount"),
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
        const { data, error } = await supabase.functions.invoke(
          getEdgeFunctionName("paystack-subaccount"),
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
      console.error("Sub-account operation error:", err);
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
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("paystack-subaccount"),
        { body: { action: "verifySubaccount" } },
      );
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
          showSuccess("Verified", "Sub-account is verified and active on Paystack.");
        } else {
          showSuccess(
            "Verified",
            "Sub-account is found but currently inactive on Paystack.",
          );
        }
      } else {
        setVerificationStatus({ verified: false, paystack_status: null, message: data.message || "Not verified" });
      }
    } catch (err) {
      console.error("Verification failed:", err);
      showError("Error", "Failed to verify sub-account with Paystack.");
      setVerificationStatus({ verified: false, message: "Verification failed" });
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
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("paystack-subaccount"),
        {
          body: {
            action: "updateSubaccount",
            subaccount: { active: !subaccount.is_active },
          },
        },
      );
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const ns = !subaccount.is_active;
      showSuccess("Updated", "Sub-account is now " + (ns ? "active" : "inactive") + ".");
      setSubaccount({ ...subaccount, is_active: ns });
    } catch (err) {
      console.error("Toggle active error:", err);
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
              await supabase.functions.invoke(
                getEdgeFunctionName("paystack-subaccount"),
                {
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
                },
              );
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
              console.error("Delete error:", err);
              showError("Error", err.message || "Failed to delete sub-account.");
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
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading Paystack settings...</Text>
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
        <View style={styles.headerCenter}>
          <Text style={styles.title}>Paystack Settings</Text>
          <Text style={styles.subtitle}>Manage your payment settlement account</Text>
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
              color="#fff"
            />
            <Text style={styles.statusText}>
              {subaccount.is_active ? "Active" : "Inactive"}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* Summary Card */}
        {subaccount && !editMode && (
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeader}>
              <Ionicons name="card-outline" size={24} color={colors.primary} />
              <Text style={styles.summaryTitle}>Settlement Account</Text>
            </View>
            <View style={styles.verifySection}>
              <View style={styles.verifyInfo}>
                {verificationStatus?.paystack_status === null ? (
                  <Ionicons name="shield-outline" size={16} color={colors.border} />
                ) : verificationStatus?.verified ? (
                  <Ionicons name="shield-checkmark" size={16} color={colors.success} />
                ) : (
                  <Ionicons name="shield-alert" size={16} color={colors.warning} />
                )}
                <Text style={styles.verifyLabel}>
                  {verificationStatus?.paystack_status === null
                    ? 'No sub-account configured'
                    : verificationStatus?.verified
                    ? 'Active ✓'
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
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="checkmark-done" size={16} color="#fff" />
                    <Text style={styles.verifyButtonText}>Check</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Business Name</Text>
              <Text style={styles.infoValue}>{subaccount.business_name || "\u2014"}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Bank / Provider</Text>
              <Text style={styles.infoValue}>{subaccount.settlement_bank || subaccount.settlement_bank_code || "\u2014"}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Account Number</Text>
              <Text style={styles.infoValue}>{subaccount.account_number || "\u2014"}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Percentage Charge</Text>
              <Text style={styles.infoValue}>{subaccount.percentage_charge != null ? `${subaccount.percentage_charge}%` : "\u2014"}</Text>
            </View>
            {subaccount.description && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Description</Text>
                <Text style={styles.infoValue}>{subaccount.description}</Text>
              </View>
            )}
            <View style={styles.summaryActions}>
              <TouchableOpacity style={styles.actionEditButton} onPress={() => setEditMode(true)}>
                <Ionicons name="pencil" size={18} color={colors.primary} />
                <Text style={styles.actionEditText}>Edit Details</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionDeleteButton} onPress={handleDeleteSubaccount}>
                <Ionicons name="trash-outline" size={18} color={colors.danger} />
                <Text style={styles.actionDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {(showForm || editMode || !subaccount) && (
          <View style={styles.formCard}>
            <View style={styles.formHeader}>
              <Ionicons name={editMode ? "pencil" : "add-circle-outline"} size={24} color={colors.accent} />
              <Text style={styles.formTitle}>{editMode ? "Edit Sub-Account" : "Configure Settlement Account"}</Text>
            </View>
            <Text style={styles.formDescription}>
              {editMode ? "Update your Paystack settlement sub-account details below." : subaccount ? "You have a settlement account. Edit above or make changes here." : "Link a Paystack settlement sub-account for super-agent payouts."}
            </Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Business Name *</Text>
            <TextInput
              style={[styles.input, formErrors.business_name && styles.inputError]}
              value={form.business_name}
              onChangeText={(t) => { setForm({...form, business_name: t}); if (formErrors.business_name) setFormErrors({...formErrors, business_name: null}); }}
              placeholder="e.g. Mysti Digital Services"
              editable={!creating && !updating}
            />
            {formErrors.business_name && <Text style={styles.errorText}>{formErrors.business_name}</Text>}
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Settlement Type</Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                style={[styles.toggleButton, form.settlement_type === "bank" && styles.toggleButtonActive]}
                onPress={() => setForm({...form, settlement_type: "bank", settlement_bank_code: "", settlement_bank_name: ""})}
                disabled={creating || updating}
              >
                <Ionicons name="business" size={18} color={form.settlement_type === "bank" ? "#fff" : colors.primary} />
                <Text style={[styles.toggleButtonText, form.settlement_type === "bank" && styles.toggleButtonTextActive]}>Bank</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleButton, form.settlement_type === "mobile_money" && styles.toggleButtonActive]}
                onPress={() => setForm({...form, settlement_type: "mobile_money", settlement_bank_code: "", settlement_bank_name: ""})}
                disabled={creating || updating}
              >
                <Ionicons name="phone-portrait" size={18} color={form.settlement_type === "mobile_money" ? "#fff" : colors.primary} />
                <Text style={[styles.toggleButtonText, form.settlement_type === "mobile_money" && styles.toggleButtonTextActive]}>Mobile Money</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>{form.settlement_type === "bank" ? "Bank *" : "Mobile Money Provider *"}</Text>
            {banksLoading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.loadingTextSmall}>Loading options...</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.pickerInput, formErrors.settlement_bank && styles.inputError]}
                onPress={() => { if (!creating && !updating) setShowBankPicker(true); }}
                disabled={creating || updating}
              >
                <View style={styles.pickerContent}>
                  {form.settlement_bank_name ? (
                    <>
                      <Text style={styles.pickerValue}>{form.settlement_bank_name}</Text>
                      <Text style={styles.pickerCode}>({form.settlement_bank_code})</Text>
                    </>
                  ) : (
                    <Text style={styles.pickerPlaceholder}>Tap to select {form.settlement_type === "bank" ? "a bank" : "a provider"}...</Text>
                  )}
                </View>
                <Ionicons name="chevron-down" size={20} color={colors.border} />
              </TouchableOpacity>
            )}
            {formErrors.settlement_bank && <Text style={styles.errorText}>{formErrors.settlement_bank}</Text>}
            {!formErrors.settlement_bank && !banksLoading && ((form.settlement_type === "bank" && banks.length === 0) || (form.settlement_type !== "bank" && mobileMoneyProviders.length === 0)) && (
              <Text style={styles.emptyStateText}>No {form.settlement_type === "bank" ? "banks" : "providers"} available.</Text>
            )}
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Account Number *</Text>
            <TextInput
              style={[styles.input, formErrors.account_number && styles.inputError]}
              value={form.account_number}
              onChangeText={(t) => { setForm({...form, account_number: t}); if (formErrors.account_number) setFormErrors({...formErrors, account_number: null}); }}
              placeholder="Enter account number"
              keyboardType="numeric-pad"
              editable={!creating && !updating && !editMode}
            />
            {formErrors.account_number && <Text style={styles.errorText}>{formErrors.account_number}</Text>}
          </View>

          <View style={styles.fieldGroup}>
            <View style={styles.chargeRow}>
              <Text style={styles.label}>Paystack Charge (%)</Text>
              <View style={styles.chargePreview}><Text style={styles.chargePreviewText}>1.95%</Text></View>
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
              onChangeText={(t) => setForm({...form, description: t})}
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
                      settlement_type: subaccount.settlement_bank_code ? "bank" : "mobile_money",
                      settlement_bank_code: subaccount.settlement_bank_code || "",
                      settlement_bank_name: subaccount.settlement_bank || "",
                      account_number: subaccount.account_number || "",
                      percentage_charge: String(subaccount.percentage_charge ?? 1.95),
                      description: subaccount.description || "",
                    });
                  } else {
                    setForm({ business_name: "", settlement_type: "bank", settlement_bank_code: "", settlement_bank_name: "", account_number: "", percentage_charge: "1.95", description: "" });
                  }
                  setFormErrors({});
                }}
                disabled={creating || updating}
              >
                <Ionicons name="close" size={18} color={colors.dark} />
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.saveButton, (creating || updating) && styles.saveButtonDisabled]}
              onPress={handleSaveSubaccount}
              disabled={creating || updating}
            >
              {creating || updating ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name={editMode ? "save-outline" : "checkmark-circle"} size={20} color="#fff" />
                  <Text style={styles.saveButtonText}>{editMode ? "Save Changes" : subaccount ? "Update Account" : "Create and Save"}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
        )}

        {/* Help Info Card */}
        <View style={styles.helpCard}>
          <Ionicons name="information-circle" size={20} color={colors.primary} />
          <Text style={styles.helpText}>Your settlement account receives split payments from customer transactions. Ensure the account details are correct before saving.</Text>
        </View>
      </ScrollView>

      {/* Bank Picker Modal */}
      <Modal visible={showBankPicker} transparent animationType="slide" onRequestClose={() => setShowBankPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  Select {form.settlement_type === "bank" ? "Bank" : "Mobile Money Provider"}
                </Text>
                <Text style={styles.modalSubtitle}>{displayedBanks.length} available</Text>
              </View>
              <TouchableOpacity onPress={() => setShowBankPicker(false)} style={styles.modalCloseButton}>
                <Ionicons name="close" size={22} color={colors.dark} />
              </TouchableOpacity>
            </View>
            {/* Search Bar */}
            <View style={styles.searchContainer}>
              <Ionicons name="search" size={20} color={colors.border} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search by name or code..."
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus
              />
              {searchQuery ? (
                <TouchableOpacity onPress={() => setSearchQuery("")}>
                  <Ionicons name="close-circle" size={18} color={colors.border} />
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
                  style={[styles.modalItem, form.settlement_bank_code === item.code && styles.modalItemSelected]}
                  onPress={() => {
                    setForm({...form, settlement_bank_code: item.code, settlement_bank_name: item.name});
                    setShowBankPicker(false);
                    setSearchQuery("");
                  }}
                >
                  <View style={styles.modalItemContent}>
                    <View style={[styles.modalItemIcon, form.settlement_bank_code === item.code ? styles.modalItemIconSelected : null]}>
                      <Ionicons name={form.settlement_type === "bank" ? "business" : "phone-portrait"} size={18} color={form.settlement_bank_code === item.code ? "#fff" : colors.primary} />
                    </View>
                    <View style={styles.modalItemTexts}>
                      <Text style={[styles.modalItemText, form.settlement_bank_code === item.code && styles.modalItemTextSelected]}>
                        {item.name}
                      </Text>
                      <Text style={styles.modalItemCode}>Code: {item.code}</Text>
                    </View>
                  </View>
                  {form.settlement_bank_code === item.code && (
                    <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                  )}
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <View style={styles.modalEmpty}>
                  <Ionicons name="search-off" size={40} color={colors.border} />
                  <Text style={styles.modalEmptyText}>{searchQuery ? "No results found" : "No items available"}</Text>
                </View>
              }
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.light },
  loadingContainer: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.light },
  loadingText: { marginTop: 12, color: colors.dark, fontSize: 16, fontWeight: "600" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 18, paddingBottom: 14, backgroundColor: colors.white, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 10 },
  headerCenter: { flex: 1 },
  backButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.light, justifyContent: "center", alignItems: "center" },
  title: { fontSize: 20, fontWeight: "800", color: colors.dark },
  subtitle: { fontSize: 12, color: colors.border, marginTop: 2 },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 },
  statusBadgeActive: { backgroundColor: colors.success },
  statusBadgeInactive: { backgroundColor: colors.border },
  statusText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  content: { padding: 20, paddingBottom: 40, gap: 20 },

  // Summary card
  summaryCard: { backgroundColor: colors.white, borderRadius: 18, padding: 18, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 3 },
  summaryHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.light },
  summaryTitle: { fontSize: 16, fontWeight: "800", color: colors.dark },
  infoRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8 },
  infoLabel: { fontSize: 13, color: colors.border, fontWeight: "600" },
  infoValue: { fontSize: 14, color: colors.dark, fontWeight: "600" },
  summaryActions: { flexDirection: "row", gap: 12, marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.light },
  actionEditButton: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, backgroundColor: colors.light, borderRadius: 12, borderWidth: 1, borderColor: colors.primary },
  actionEditText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  actionDeleteButton: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, backgroundColor: colors.light, borderRadius: 12, borderWidth: 1, borderColor: colors.danger },
  actionDeleteText: { color: colors.danger, fontSize: 13, fontWeight: "700" },

  // Form card
  formCard: { backgroundColor: colors.white, borderRadius: 18, padding: 18, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 3 },
  formHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  formTitle: { fontSize: 16, fontWeight: "800", color: colors.dark },
  formDescription: { fontSize: 13, color: colors.border, lineHeight: 20, marginBottom: 16 },
  fieldGroup: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: "700", color: colors.dark, marginBottom: 6 },
  input: { borderWidth: 1.5, borderColor: colors.border, borderRadius: 12, padding: 12, fontSize: 14, backgroundColor: colors.light, color: colors.dark },
  inputError: { borderColor: colors.danger, backgroundColor: "#fef2f2" },
  textArea: { minHeight: 80, textAlignVertical: "top" },
  errorText: { fontSize: 12, color: colors.danger, marginTop: 4, fontWeight: "600" },
  // Toggle buttons
  toggleRow: { flexDirection: "row", gap: 10 },
  toggleButton: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1.5, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.white },
  toggleButtonActive: { borderColor: colors.primary, backgroundColor: colors.primary + "10" },
  toggleButtonText: { fontSize: 14, fontWeight: "700", color: colors.dark },
  toggleButtonTextActive: { color: colors.primary },

  // Picker
  pickerInput: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1.5, borderColor: colors.border, borderRadius: 12, padding: 12, backgroundColor: colors.light },
  pickerContent: { flex: 1 },
  pickerValue: { fontSize: 14, color: colors.dark, fontWeight: "600" },
  pickerCode: { fontSize: 12, color: colors.border, marginTop: 2 },
  pickerPlaceholder: { fontSize: 14, color: colors.border },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 },
  loadingTextSmall: { fontSize: 13, color: colors.border },
  emptyStateText: { fontSize: 12, color: colors.danger, marginTop: 4, fontWeight: "600" },

  // Charge preview
  chargeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  chargePreview: { backgroundColor: colors.primary + "15", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8 },
  chargePreviewText: { fontSize: 13, fontWeight: "800", color: colors.primary },

  // Buttons
  buttonRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  cancelButton: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 14, backgroundColor: colors.light, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.dark, fontSize: 14, fontWeight: "700" },
  saveButton: { flex: 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, backgroundColor: colors.primary, borderRadius: 12 },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonText: { color: "#fff", fontSize: 15, fontWeight: "700" },

  // Charge input (read-only)
  chargeInput: {
    backgroundColor: colors.light,
    color: "#999",
  },

  // Help card
  helpCard: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: colors.primary + "08", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.primary + "20" },
  helpText: { flex: 1, fontSize: 12, color: colors.dark, lineHeight: 18 },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalContent: { backgroundColor: colors.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: "80%", paddingBottom: 20 },
  modalHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 20, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: colors.light },
  modalTitle: { fontSize: 18, fontWeight: "800", color: colors.dark },
  modalSubtitle: { fontSize: 12, color: colors.border, marginTop: 2 },
  modalCloseButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.light, justifyContent: "center", alignItems: "center" },

  // Search
  searchContainer: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 20, marginTop: 14, marginBottom: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.light, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  searchInput: { flex: 1, fontSize: 14, color: colors.dark },

  // Modal list
  modalList: { paddingHorizontal: 20, paddingBottom: 20 },
  modalItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.light, marginBottom: 6 },
  modalItemSelected: { borderColor: colors.primary, backgroundColor: colors.primary + "08" },
  modalItemContent: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  modalItemIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.light, justifyContent: "center", alignItems: "center" },
  modalItemIconSelected: { backgroundColor: colors.primary },
  modalItemTexts: { flex: 1 },
  modalItemText: { fontSize: 14, color: colors.dark, fontWeight: "600" },
  modalItemTextSelected: { color: colors.primary },
  modalItemCode: { fontSize: 12, color: colors.border, marginTop: 2 },
  // Verify section in summary card
  verifySection: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10, paddingHorizontal: 2, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.light },
  verifyInfo: { flexDirection: "row", alignItems: "center", gap: 6 },
  verifyLabel: { fontSize: 13, color: colors.dark, fontWeight: "600" },
  verifyButton: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  verifyButtonText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  verifyButtonVerified: { backgroundColor: colors.success },
  verifyButtonNeutral: { backgroundColor: colors.border },
  verifyButtonInactive: { backgroundColor: colors.warning },

  modalEmpty: { alignItems: "center", justifyContent: "center", paddingVertical: 40, gap: 10 },
  modalEmptyText: { fontSize: 14, color: colors.border, fontWeight: "600" },
});
