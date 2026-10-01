import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { fonts } from "../components/theme";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useTheme } from "../contexts/ThemeContext";
import { supabase, getPaystackPublicKey } from "../lib/supabase";
import { getEdgeFunctionName } from "../lib/env";
import { usePaystackPayment } from "../hooks/usePaystackPayment";
import { useNotification } from "../contexts/NotificationContext";
import { useProfile } from "../contexts/ProfileContext";
import { getGhanaPhoneError, sanitizeGhanaPhone } from "../lib/ghanaPhone";

const escapeJs = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");

// The payment sheet is our own markup (the Paystack iframe it opens is not),
// so it takes the active palette rather than staying hardcoded light.
const mobilePaymentHtml = ({
  key,
  email,
  reference,
  amount,
  c,
  subaccount,
}) => `
<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;background:${c.canvas};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}.card{background:${c.surface};border:1px solid ${c.hairline};border-radius:22px;padding:28px 22px;width:84%;text-align:center;box-shadow:0 12px 30px ${c.shadow}}.mark{width:62px;height:62px;border-radius:20px;background:${c.mintDim};color:${c.onAccent};display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:28px;font-weight:800}.label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:${c.mint};font-weight:800}.amount{font-size:34px;font-weight:900;margin:7px 0 22px;color:${c.textPrimary}}button{width:100%;border:0;border-radius:999px;padding:17px;background:${c.mint};color:${c.onAccent};font-size:16px;font-weight:800}.note{font-size:11px;color:${c.textMuted};margin-top:15px}</style></head>
<body><div class="card"><div class="mark">AFA</div><div class="label">Registration fee</div><div class="amount">GHS ${amount.toFixed(2)}</div><button id="pay">Pay securely with Paystack</button><div class="note">${subaccount ? "Your payment goes to your super agent." : "Your payment goes to the platform's main Paystack account."}</div></div>
<script src="https://js.paystack.co/v1/inline.js"></script><script>
document.getElementById('pay').onclick=function(){var started=Date.now();var open=function(){if(!window.PaystackPop){if(Date.now()-started<10000){setTimeout(open,100);return;}window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'Paystack could not be loaded'}));return;}var opts={key:'${escapeJs(key)}',email:'${escapeJs(email)}',amount:${Math.round(amount * 100)},currency:'GHS',ref:'${escapeJs(reference)}',callback:function(r){window.ReactNativeWebView.postMessage(JSON.stringify({type:'success',data:r}))},onClose:function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'cancel'}))}};${subaccount ? "opts.subaccount='" + escapeJs(subaccount) + "';" : ""}PaystackPop.setup(opts).openIframe()};open()};
</script></body></html>`;

const initialForm = {
  fullName: "",
  phone: "",
  idType: "National ID",
  idNumber: "",
  townCity: "",
  occupation: "",
  additionalInfo: "",
};

export default function AfaRegistrationScreen({ navigation }) {
  const { showError, showSuccess } = useNotification();
  const { isSuperAgent: isSuperAgentProfile } = useProfile();
  const [form, setForm] = useState(initialForm);
  const [settings, setSettings] = useState(null);
  const [registrations, setRegistrations] = useState([]);
  // The price THIS super agent charges their own sub-agents, plus the price
  // the payer (this user) is quoted. Both come from the server so the figure
  // shown is the figure the registration will record.
  const [ownAgentPricing, setOwnAgentPricing] = useState(null);
  const [subAgentBasePrice, setSubAgentBasePrice] = useState("");
  const [savingPricing, setSavingPricing] = useState(false);
  const [quotedFee, setQuotedFee] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [paymentVisible, setPaymentVisible] = useState(false);
  const [pendingRegistration, setPendingRegistration] = useState(null);
  // Set when a sub-agent's payment is routed to their own super agent's
  // Paystack subaccount, so the charge reaches the super agent rather than
  // the platform. Null means the platform is the beneficiary.
  const [paystackSubaccount, setPaystackSubaccount] = useState(null);
  const [publicKey, setPublicKey] = useState("");
  const [webPaymentRequested, setWebPaymentRequested] = useState(false);
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const [requestingAnother, setRequestingAnother] = useState(false);

  const loadRegistration = useCallback(async () => {
    try {
      const { data: userData, error: userError } =
        await supabase.auth.getUser();
      if (userError || !userData.user) return;
      setUser(userData.user);
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("afa-registration"),
        { body: { action: "getStatus" } },
      );
      if (error) throw error;
      setSettings(data?.settings || null);
      setRegistrations(
        Array.isArray(data?.registrations) ? data.registrations : [],
      );
      setOwnAgentPricing(data?.ownAgentPricing || null);
      setSubAgentBasePrice(
        data?.ownAgentPricing?.sub_agent_base_price == null
          ? ""
          : String(data.ownAgentPricing.sub_agent_base_price),
      );
      setQuotedFee(data?.quotedFee == null ? null : Number(data.quotedFee));
    } catch (error) {
      showError(
        "AFA Registration",
        error.message || "Unable to load registration details",
      );
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    loadRegistration();
    getPaystackPublicKey()
      .then((key) => setPublicKey(key || ""))
      .catch(() => setPublicKey(""));
  }, [loadRegistration]);

  const updateField = (field, value) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const validate = () => {
    if (
      !form.fullName.trim() ||
      !form.phone.trim() ||
      !form.idNumber.trim() ||
      !form.townCity.trim() ||
      !form.occupation.trim()
    ) {
      showError(
        "Missing Details",
        "Complete all required registration details.",
      );
      return false;
    }
    // The field is sanitised as the user types, so this only has to catch an
    // incomplete or wrongly-prefixed number. `getGhanaPhoneError` names the
    // actual problem rather than reporting one generic message for every
    // failure, which is what the single regex it replaced did.
    const phoneError = getGhanaPhoneError(form.phone);
    if (phoneError) {
      showError("Invalid Phone", phoneError);
      return false;
    }
    if (form.idNumber.trim().length < 5) {
      showError("Invalid ID", "Enter a valid ID number.");
      return false;
    }
    return true;
  };

  const verifyPayment = useCallback(
    async (response) => {
      setPaymentCompleted(true);
      setPaymentVisible(false);
      const reference = response?.reference || response?.trxref;
      try {
        const { data, error } = await supabase.functions.invoke(
          getEdgeFunctionName("afa-registration"),
          {
            body: {
              action: "verifyPaystack",
              registrationId: pendingRegistration.id,
              reference,
            },
          },
        );
        if (error) throw error;
        if (data?.success) {
          showSuccess(
            "Registration Complete",
            "Your AFA registration payment was confirmed.",
          );
          setForm(initialForm);
          setRequestingAnother(false);
          await loadRegistration();
        }
      } catch (error) {
        showError(
          "Payment Verification",
          error.message || "Contact support if you were charged.",
        );
      }
    },
    [loadRegistration, pendingRegistration, showError, showSuccess],
  );

  const webPaystackConfig = useMemo(() => {
    if (
      Platform.OS !== "web" ||
      !pendingRegistration ||
      !user?.email ||
      !publicKey
    )
      return null;
    return {
      publicKey,
      email: user.email,
      amount: Math.round(Number(pendingRegistration.fee_amount) * 100),
      currency: "GHS",
      reference: pendingRegistration.payment_reference,
      // Routes the money to the sub-agent's own super agent when that agent set
      // a sub-agent AFA price and has an active Paystack subaccount.
      subaccount: paystackSubaccount || null,
      metadata: {
        type: "afa_registration",
        registration_id: pendingRegistration.id,
      },
      onSuccess: verifyPayment,
      onClose: () => {
        setPaymentVisible(false);
        if (!paymentCompleted)
          showError("Payment Cancelled", "Registration payment was cancelled.");
      },
    };
  }, [
    pendingRegistration,
    paystackSubaccount,
    user,
    publicKey,
    verifyPayment,
    paymentCompleted,
    showError,
  ]);

  const { initializePayment, isLoaded } = usePaystackPayment(webPaystackConfig);
  useEffect(() => {
    if (
      Platform.OS === "web" &&
      webPaymentRequested &&
      webPaystackConfig &&
      isLoaded
    ) {
      setWebPaymentRequested(false);
      setPaymentVisible(true);
      initializePayment();
    }
  }, [webPaymentRequested, webPaystackConfig, isLoaded, initializePayment]);

  const submitRegistration = async () => {
    if (!validate() || !settings?.is_enabled) return;
    setSubmitting(true);
    setPaymentCompleted(false);
    try {
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("afa-registration"),
        { body: { action: "createRegistration", ...form } },
      );
      if (error) throw error;
      if (data?.success && data.registration?.status === "active") {
        showSuccess(
          "Registration Complete",
          "The registration fee was paid from your wallet.",
        );
        setForm(initialForm);
        setRequestingAnother(false);
        await loadRegistration();
        return;
      }
      if (!data?.success || data?.paymentMethod !== "paystack")
        throw new Error(data?.error || "Unable to start payment");
      setPendingRegistration(data.registration);
      setPaystackSubaccount(data?.paystackSubaccountCode || null);
      if (Platform.OS === "web") setWebPaymentRequested(true);
      else setPaymentVisible(true);
    } catch (error) {
      showError(
        "AFA Registration",
        error.message || "Unable to complete registration",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const activeRegistration = registrations.find(
    (item) => item.status === "active",
  );
  // Role from `public.user_profiles` via the profile context. The old read of
  // `user_metadata.role` is self-assignable, and `app_metadata.role` lives in
  // the access token - neither may decide whether this account may set a
  // sub-agent AFA price.
  const isSuperAgent = isSuperAgentProfile;

  // A super agent sets what their OWN sub-agents pay. Routed through the edge
  // function rather than a direct table write so the row is always scoped to
  // the caller's id - a direct write would rely on RLS alone for ownership.
  const saveSubAgentPricing = async () => {
    const raw = subAgentBasePrice.trim();
    if (raw === "") {
      showError(
        "Base price required",
        "Enter the amount your sub-agents should pay.",
      );
      return;
    }
    const price = Number(raw);
    if (!Number.isFinite(price) || price < 0) {
      showError("Invalid price", "Enter a valid amount.");
      return;
    }

    setSavingPricing(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        getEdgeFunctionName("afa-registration"),
        {
          body: {
            action: "saveSubAgentPricing",
            subAgentBasePrice: price,
            isEnabled: true,
          },
        },
      );
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Unable to save");
      setOwnAgentPricing(data.pricing);
      showSuccess(
        "Price updated",
        `Your sub-agents will now pay GHS ${Number(price).toFixed(2)} per AFA registration.`,
      );
    } catch (error) {
      showError(
        "AFA Pricing",
        error.message || "Unable to save the sub-agent price",
      );
    } finally {
      setSavingPricing(false);
    }
  };

  const theme = useTheme();
  const c = theme.c;
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useAfaStyles(c, topInset);

  if (loading) {
    return (
      <ThemedScreen style={styles.safeArea}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={c.mint} />
        </View>
      </ThemedScreen>
    );
  }

  return (
    <ThemedScreen style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={23} color={c.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>Mystiwan E-Business</Text>
          <Text style={styles.title}>AFA Registration</Text>
        </View>
        <View style={styles.headerMark}>
          <Text style={styles.headerMarkText}>AFA</Text>
        </View>
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="shield-checkmark" size={30} color={c.heroText} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>
              {activeRegistration
                ? "Registration Active"
                : "Register with confidence"}
            </Text>
            <Text style={styles.heroText}>
              {activeRegistration
                ? `${registrations.length} request${registrations.length !== 1 ? "s" : ""} recorded · ${new Date(activeRegistration.paid_at || activeRegistration.created_at).toLocaleDateString()}`
                : "Submit your valid identity details and complete the official AFA registration payment."}
            </Text>
          </View>
        </View>

        {activeRegistration && (
          <View style={styles.activeCard}>
            <View style={styles.activeTopRow}>
              <View style={styles.activeIdentity}>
                <View style={styles.activeAvatar}>
                  <Text style={styles.activeAvatarText}>
                    {activeRegistration.full_name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.activeIdentityCopy}>
                  <Text style={styles.activeName}>
                    {activeRegistration.full_name}
                  </Text>
                  <Text style={styles.activePhone}>
                    {activeRegistration.phone}
                  </Text>
                </View>
              </View>
              <View style={styles.activeStatus}>
                <View style={styles.activeDot} />
                <Text style={styles.activeStatusText}>Active</Text>
              </View>
            </View>
            <View style={styles.activeDivider} />
            <View style={styles.activeInfoGrid}>
              <ActiveInfo
                icon="id-card-outline"
                label="ID number"
                value={activeRegistration.id_number}
              />
              <ActiveInfo
                icon="shield-checkmark-outline"
                label="ID type"
                value={activeRegistration.id_type}
              />
              <ActiveInfo
                icon="cash-outline"
                label="Paid amount"
                value={`GHS ${Number(activeRegistration.fee_amount).toFixed(2)}`}
              />
              <ActiveInfo
                icon="card-outline"
                label="Payment"
                value={
                  activeRegistration.payment_method === "wallet"
                    ? "Wallet"
                    : "Paystack"
                }
              />
            </View>
            <View style={styles.activeReference}>
              <Text style={styles.activeReferenceLabel}>PAYMENT REFERENCE</Text>
              <Text style={styles.activeReferenceValue} numberOfLines={1}>
                {activeRegistration.payment_reference}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.requestAnotherButton}
              onPress={() => {
                setRequestingAnother(true);
                setForm(initialForm);
              }}
              disabled={!settings?.is_enabled}
            >
              <View style={styles.requestAnotherIcon}>
                <Ionicons name="add" size={20} color={c.mintDim} />
              </View>
              <View style={styles.requestAnotherCopy}>
                <Text style={styles.requestAnotherTitle}>
                  Request another registration
                </Text>
                <Text style={styles.requestAnotherText}>
                  Create a new request with separate details and payment
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={19} color={c.mintDim} />
            </TouchableOpacity>
          </View>
        )}

        {(requestingAnother || !activeRegistration) && settings?.is_enabled && (
          <>
            <View style={styles.feeCard}>
              <View>
                <Text style={styles.feeLabel}>REGISTRATION FEE</Text>
                <Text style={styles.feeNote}>
                  {isSuperAgent
                    ? "Paid from your Super Agent wallet"
                    : paystackSubaccount
                      ? "Paid to your super agent"
                      : "Pay securely to the platform account"}
                </Text>
              </View>
              {/* The tiered quote, not the global registration_fee: a
                  sub-agent may be charged their own super agent's price. */}
              <Text style={styles.feeAmount}>
                GHS{" "}
                {Number(quotedFee ?? settings.registration_fee ?? 0).toFixed(2)}
              </Text>
            </View>

            {/* Super agents set what their own sub-agents pay. The payment is
                routed to their Paystack subaccount, so this price is revenue
                they actually keep. */}
            {isSuperAgent ? (
              <View style={styles.agentPricingCard}>
                <Text style={styles.agentPricingTitle}>
                  Sub-agent AFA price
                </Text>
                <Text style={styles.agentPricingNote}>
                  The amount each of your sub-agents pays per registration. The
                  payment is routed to your Paystack subaccount, so this amount
                  is yours.
                </Text>
                <View style={styles.agentPricingRow}>
                  <TextInput
                    style={styles.agentPricingInput}
                    value={subAgentBasePrice}
                    onChangeText={(value) =>
                      setSubAgentBasePrice(value.replace(/[^0-9.]/g, ""))
                    }
                    keyboardType="decimal-pad"
                    placeholder={String(
                      Number(settings.registration_fee ?? 0).toFixed(2),
                    )}
                    placeholderTextColor={c.textMuted}
                  />
                  <TouchableOpacity
                    style={[
                      styles.agentPricingSave,
                      savingPricing && styles.disabled,
                    ]}
                    onPress={saveSubAgentPricing}
                    disabled={savingPricing}
                  >
                    <Text style={styles.agentPricingSaveText}>
                      {savingPricing ? "..." : "Save"}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}

            <View style={styles.formCard}>
              <View style={styles.formHeaderRow}>
                <View style={styles.formHeaderCopy}>
                  <Text style={styles.sectionTitle}>
                    {activeRegistration
                      ? "New registration request"
                      : "Personal details"}
                  </Text>
                  <Text style={styles.sectionSubtitle}>
                    Enter the details and payment for this request.
                  </Text>
                </View>
                {activeRegistration && requestingAnother ? (
                  <TouchableOpacity
                    style={styles.closeFormButton}
                    onPress={() => {
                      setRequestingAnother(false);
                      setForm(initialForm);
                    }}
                  >
                    <Ionicons name="close" size={20} color={c.mintDim} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <Field
                label="Full name"
                icon="person-outline"
                value={form.fullName}
                onChangeText={(v) => updateField("fullName", v)}
                placeholder="Enter your full legal name"
              />
              <Field
                label="Phone number"
                icon="call-outline"
                value={form.phone}
                onChangeText={(v) =>
                  updateField("phone", sanitizeGhanaPhone(v))
                }
                placeholder="e.g. 0244000000"
                keyboardType="phone-pad"
                maxLength={10}
              />
              <Text style={styles.label}>ID type</Text>
              <View style={styles.idTypeRow}>
                {["National ID", "Voters ID"].map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[
                      styles.idTypeButton,
                      form.idType === type && styles.idTypeButtonActive,
                    ]}
                    onPress={() => updateField("idType", type)}
                  >
                    <Ionicons
                      name={
                        form.idType === type
                          ? "radio-button-on"
                          : "radio-button-off"
                      }
                      size={17}
                      color={form.idType === type ? c.mintDim : c.textMuted}
                    />
                    <Text
                      style={[
                        styles.idTypeText,
                        form.idType === type && styles.idTypeTextActive,
                      ]}
                    >
                      {type}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Field
                label="ID number"
                icon="id-card-outline"
                value={form.idNumber}
                onChangeText={(v) => updateField("idNumber", v)}
                placeholder="Enter ID number"
                autoCapitalize="characters"
              />
              <Field
                label="Town / City"
                icon="location-outline"
                value={form.townCity}
                onChangeText={(v) => updateField("townCity", v)}
                placeholder="Enter your town or city"
              />
              <Field
                label="Occupation"
                icon="briefcase-outline"
                value={form.occupation}
                onChangeText={(v) => updateField("occupation", v)}
                placeholder="Enter your occupation"
              />
              <Field
                label="Additional information (optional)"
                icon="information-circle-outline"
                value={form.additionalInfo}
                onChangeText={(v) => updateField("additionalInfo", v)}
                placeholder="Any additional information"
                multiline
              />
            </View>

            <TouchableOpacity
              style={[styles.payButton, submitting && styles.disabled]}
              onPress={submitRegistration}
              disabled={submitting}
            >
              <Ionicons
                name={isSuperAgent ? "wallet" : "shield-checkmark"}
                size={20}
                color={c.onAccent}
              />
              <Text style={styles.payButtonText}>
                {submitting
                  ? "Processing..."
                  : isSuperAgent
                    ? "Register from Wallet"
                    : "Register & Pay"}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {!settings?.is_enabled && !activeRegistration && (
          <View style={styles.unavailable}>
            <Ionicons name="time-outline" size={30} color={c.amber} />
            <Text style={styles.unavailableTitle}>
              Registration temporarily unavailable
            </Text>
            <Text style={styles.unavailableText}>
              The admin has not enabled AFA registration yet. Please check back
              later.
            </Text>
          </View>
        )}
      </KeyboardAwareScrollView>

      {paymentVisible && pendingRegistration && Platform.OS !== "web" && (
        <Modal visible animationType="slide">
          <WebView
            source={{
              html: mobilePaymentHtml({
                key: publicKey,
                email: user?.email || "",
                reference: pendingRegistration.payment_reference,
                amount: Number(pendingRegistration.fee_amount),
                subaccount: paystackSubaccount,
                c,
              }),
            }}
            style={styles.flex}
            javaScriptEnabled
            domStorageEnabled
            onMessage={(event) => {
              const message = JSON.parse(event.nativeEvent.data);
              if (message.type === "success") verifyPayment(message.data);
              if (message.type === "cancel") {
                setPaymentVisible(false);
                if (!paymentCompleted)
                  showError(
                    "Payment Cancelled",
                    "Registration payment was cancelled.",
                  );
              }
              if (message.type === "error")
                showError("Payment Error", message.message);
            }}
          />
        </Modal>
      )}
    </ThemedScreen>
  );
}

function ActiveInfo({ icon, label, value }) {
  const theme = useTheme();
  const styles = useAfaStyles(theme.c);
  return (
    <View style={styles.activeInfoItem}>
      <View style={styles.activeInfoRow}>
        <Ionicons
          name={icon}
          size={14}
          color={theme.c.mintDim}
          style={styles.activeInfoIcon}
        />
        <Text style={styles.activeInfoLabel}>{label}</Text>
      </View>
      <Text style={styles.activeInfoValue} numberOfLines={1}>
        {value || "N/A"}
      </Text>
    </View>
  );
}

function Field({ label, icon, multiline, ...props }) {
  const theme = useTheme();
  const styles = useAfaStyles(theme.c);
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, multiline && styles.multilineWrap]}>
        <Ionicons name={icon} size={19} color={theme.c.textMuted} />
        <TextInput
          {...props}
          multiline={multiline}
          style={[styles.input, multiline && styles.multilineInput]}
          placeholderTextColor={theme.c.textMuted}
        />
      </View>
    </View>
  );
}

// Layered on the shared kit. The hero and the "active registration" card are
// the two pieces that carry their own colour logic; everything else is the
// standard surface/type ramp.
const useAfaStyles = (c, topInset = 0) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    ...base,
    safeArea: { ...base.screen },
    center: { ...base.center },
    header: {
      ...base.header,
      paddingHorizontal: 18,
      paddingTop: 12 + topInset,
      paddingBottom: 14,
    },
    backButton: { ...base.backButton, borderRadius: 999 },
    headerCopy: { flex: 1, marginLeft: 12 },
    eyebrow: {
      ...base.sectionEyebrow,
      fontSize: 9,
      letterSpacing: 1.1,
      marginBottom: 0,
    },
    title: { ...base.headerTitle, fontSize: 22, marginTop: 2 },
    headerMark: {
      width: 43,
      height: 43,
      borderRadius: 14,
      backgroundColor: c.mintDim,
      alignItems: "center",
      justifyContent: "center",
    },
    headerMarkText: {
      fontFamily: fonts.bodyBold,
      fontSize: 12,
      color: c.onAccent,
    },
    content: { ...base.body, paddingTop: 18, paddingBottom: 40 },

    // Hero keeps its filled treatment in both schemes via the accent ramp.
    hero: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.mintDim,
      borderRadius: 24,
      padding: 18,
      marginBottom: 16,
    },
    heroIcon: {
      width: 52,
      height: 52,
      borderRadius: 18,
      backgroundColor: "rgba(255,255,255,.18)",
      alignItems: "center",
      justifyContent: "center",
    },
    heroCopy: { flex: 1, marginLeft: 14 },
    heroTitle: { fontFamily: fonts.display, fontSize: 18, color: c.onAccent },
    heroText: {
      fontFamily: fonts.body,
      fontSize: 12,
      lineHeight: 18,
      color: c.onAccent,
      opacity: 0.8,
      marginTop: 4,
    },

    feeCard: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: `${c.mint}14`,
      borderColor: `${c.mint}33`,
      borderWidth: 1,
      borderRadius: 18,
      padding: 16,
      marginBottom: 16,
    },
    feeLabel: {
      fontFamily: fonts.bodyBold,
      fontSize: 10,
      color: c.mint,
      letterSpacing: 0.8,
    },
    feeNote: {
      fontFamily: fonts.body,
      fontSize: 10,
      color: c.textMuted,
      marginTop: 3,
    },
    feeAmount: { fontFamily: fonts.display, fontSize: 22, color: c.mint },

    /* ---------- Super agent sub-agent AFA price ---------- */
    // Deliberately quieter than the fee card: this is a configuration surface
    // for a super agent, not the primary action of the screen.
    agentPricingCard: {
      backgroundColor: c.surface,
      borderColor: c.hairline,
      borderWidth: 1,
      borderRadius: 18,
      padding: 16,
      marginBottom: 16,
    },
    agentPricingTitle: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.textPrimary,
    },
    agentPricingNote: {
      fontFamily: fonts.body,
      fontSize: 11,
      lineHeight: 17,
      color: c.textMuted,
      marginTop: 5,
      marginBottom: 12,
    },
    agentPricingRow: { flexDirection: "row", gap: 9, alignItems: "center" },
    agentPricingInput: {
      flex: 1,
      backgroundColor: c.canvas,
      borderColor: c.hairlineStrong,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 11,
      color: c.textPrimary,
      fontFamily: fonts.bodyBold,
      fontSize: 15,
    },
    agentPricingSave: {
      backgroundColor: c.mint,
      borderRadius: 12,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    agentPricingSaveText: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.onAccent,
    },

    formCard: { ...base.card, borderRadius: 22, padding: 17, marginBottom: 16 },
    sectionTitle: { ...base.sectionTitle, fontSize: 17, marginBottom: 0 },
    formHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 17,
    },
    formHeaderCopy: { flex: 1 },
    sectionSubtitle: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 3,
    },
    closeFormButton: {
      width: 36,
      height: 36,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceHover,
    },

    fieldGroup: { marginBottom: 15 },
    label: { ...base.label, fontSize: 12 },
    inputWrap: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.hairline,
      borderRadius: 15,
      backgroundColor: c.canvasRaised,
      paddingHorizontal: 12,
    },
    multilineWrap: { alignItems: "flex-start", paddingTop: 12 },
    input: {
      flex: 1,
      fontFamily: fonts.body,
      color: c.textPrimary,
      fontSize: 15,
      paddingVertical: 13,
      paddingLeft: 9,
    },
    multilineInput: { minHeight: 70, textAlignVertical: "top" },

    idTypeRow: { flexDirection: "row", gap: 9, marginBottom: 15 },
    idTypeButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: c.hairline,
      borderRadius: 14,
      backgroundColor: c.surface,
      paddingVertical: 13,
    },
    idTypeButtonActive: { backgroundColor: `${c.mint}14`, borderColor: c.mint },
    idTypeText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.textSecondary,
      marginLeft: 6,
    },
    idTypeTextActive: { color: c.mint },

    payButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.mint,
      borderRadius: 999,
      paddingVertical: 17,
    },
    payButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 16,
      color: c.onAccent,
      marginLeft: 8,
    },
    disabled: { opacity: 0.55 },

    unavailable: {
      ...base.card,
      borderRadius: 20,
      alignItems: "center",
      padding: 28,
    },
    unavailableTitle: {
      ...base.sectionTitle,
      fontSize: 17,
      marginTop: 12,
      marginBottom: 0,
    },
    unavailableText: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textMuted,
      textAlign: "center",
      marginTop: 7,
      lineHeight: 20,
    },

    activeCard: { ...base.card, borderRadius: 24, padding: 17 },
    activeTopRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    activeIdentity: { flexDirection: "row", alignItems: "center", flex: 1 },
    activeAvatar: {
      width: 46,
      height: 46,
      borderRadius: 16,
      backgroundColor: c.mintDim,
      alignItems: "center",
      justifyContent: "center",
    },
    activeAvatarText: {
      fontFamily: fonts.display,
      fontSize: 18,
      color: c.onAccent,
    },
    activeIdentityCopy: { flex: 1, marginLeft: 11 },
    activeName: {
      fontFamily: fonts.bodySemi,
      fontSize: 16,
      color: c.textPrimary,
    },
    activePhone: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 3,
    },
    activeStatus: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: `${c.mint}1F`,
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    activeDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: c.mint,
      marginRight: 5,
    },
    activeStatusText: {
      fontFamily: fonts.bodyBold,
      fontSize: 10,
      color: c.mint,
      textTransform: "uppercase",
    },
    activeDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.hairline,
      marginVertical: 14,
    },
    activeInfoGrid: { flexDirection: "row", flexWrap: "wrap" },
    activeInfoItem: { width: "50%", paddingVertical: 7, paddingRight: 8 },
    activeInfoRow: { flexDirection: "row", alignItems: "center" },
    activeInfoIcon: { marginRight: 5 },
    activeInfoLabel: {
      fontFamily: fonts.body,
      fontSize: 10,
      color: c.textMuted,
    },
    activeInfoValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.textPrimary,
      marginTop: 2,
      marginLeft: 24,
    },
    activeReference: {
      backgroundColor: c.canvasRaised,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 10,
      marginTop: 12,
    },
    activeReferenceLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 9,
      color: c.textMuted,
      letterSpacing: 0.7,
    },
    activeReferenceValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 11,
      color: c.mint,
      marginTop: 4,
    },

    requestAnotherButton: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: `${c.mint}14`,
      borderColor: `${c.mint}33`,
      borderWidth: 1,
      borderRadius: 16,
      padding: 12,
      marginTop: 12,
    },
    requestAnotherIcon: {
      width: 36,
      height: 36,
      borderRadius: 12,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    requestAnotherCopy: { flex: 1, marginHorizontal: 10 },
    requestAnotherTitle: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.mint,
    },
    requestAnotherText: {
      fontFamily: fonts.body,
      fontSize: 10,
      color: c.textMuted,
      marginTop: 2,
    },
  });
};
