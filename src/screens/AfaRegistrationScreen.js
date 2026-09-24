import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import colors from "../components/theme";
import { supabase, getPaystackPublicKey } from "../lib/supabase";
import { getEdgeFunctionName } from "../lib/env";
import { usePaystackPayment } from "../hooks/usePaystackPayment";
import { useNotification } from "../contexts/NotificationContext";

const escapeJs = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");

const mobilePaymentHtml = ({ key, email, reference, amount }) => `
<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;background:#eef5f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}.card{background:white;border-radius:22px;padding:28px 22px;width:84%;text-align:center;box-shadow:0 12px 30px rgba(0,70,70,.14)}.mark{width:62px;height:62px;border-radius:20px;background:#006769;color:white;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:28px;font-weight:800}.label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#2B5F1F;font-weight:800}.amount{font-size:34px;font-weight:900;margin:7px 0 22px;color:#1A1A1A}button{width:100%;border:0;border-radius:14px;padding:17px;background:#006769;color:#fff;font-size:16px;font-weight:800}.note{font-size:11px;color:#789;margin-top:15px}</style></head>
<body><div class="card"><div class="mark">AFA</div><div class="label">Registration fee</div><div class="amount">GHS ${amount.toFixed(2)}</div><button id="pay">Pay securely with Paystack</button><div class="note">Your payment goes to the platform's main Paystack account.</div></div>
<script src="https://js.paystack.co/v1/inline.js"></script><script>
document.getElementById('pay').onclick=function(){var started=Date.now();var open=function(){if(!window.PaystackPop){if(Date.now()-started<10000){setTimeout(open,100);return;}window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'Paystack could not be loaded'}));return;}PaystackPop.setup({key:'${escapeJs(key)}',email:'${escapeJs(email)}',amount:${Math.round(amount * 100)},currency:'GHS',ref:'${escapeJs(reference)}',callback:function(r){window.ReactNativeWebView.postMessage(JSON.stringify({type:'success',data:r}))},onClose:function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'cancel'}))}}).openIframe()};open()};
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
  const [form, setForm] = useState(initialForm);
  const [settings, setSettings] = useState(null);
  const [registrations, setRegistrations] = useState([]);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [paymentVisible, setPaymentVisible] = useState(false);
  const [pendingRegistration, setPendingRegistration] = useState(null);
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
    const phoneRegex = /^(\+?233|0)?[2356789]\d{8}$/;
    if (!phoneRegex.test(form.phone.replace(/\s+/g, ""))) {
      showError("Invalid Phone", "Enter a valid Ghana phone number.");
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
  const normalizedRole = String(
    user?.user_metadata?.role || user?.app_metadata?.role || "",
  ).toLowerCase();
  const isSuperAgent =
    normalizedRole === "superagent" || normalizedRole === "super_agent";

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.light} />
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={23} color={colors.primary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>Mystiwan E-Business</Text>
          <Text style={styles.title}>AFA Registration</Text>
        </View>
        <View style={styles.headerMark}>
          <Text style={styles.headerMarkText}>AFA</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero}>
            <View style={styles.heroIcon}>
              <Ionicons
                name="shield-checkmark"
                size={30}
                color={colors.white}
              />
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
                <Text style={styles.activeReferenceLabel}>
                  PAYMENT REFERENCE
                </Text>
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
                  <Ionicons name="add" size={20} color={colors.secondary} />
                </View>
                <View style={styles.requestAnotherCopy}>
                  <Text style={styles.requestAnotherTitle}>
                    Request another registration
                  </Text>
                  <Text style={styles.requestAnotherText}>
                    Create a new request with separate details and payment
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={19}
                  color={colors.secondary}
                />
              </TouchableOpacity>
            </View>
          )}

          {(requestingAnother || !activeRegistration) &&
            settings?.is_enabled && (
              <>
                <View style={styles.feeCard}>
                  <View>
                    <Text style={styles.feeLabel}>REGISTRATION FEE</Text>
                    <Text style={styles.feeNote}>
                      {isSuperAgent
                        ? "Paid from your Super Agent wallet"
                        : "Pay securely to the platform account"}
                    </Text>
                  </View>
                  <Text style={styles.feeAmount}>
                    GHS {Number(settings.registration_fee).toFixed(2)}
                  </Text>
                </View>

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
                        <Ionicons
                          name="close"
                          size={20}
                          color={colors.secondary}
                        />
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
                    onChangeText={(v) => updateField("phone", v)}
                    placeholder="e.g. 0244000000"
                    keyboardType="phone-pad"
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
                          color={
                            form.idType === type
                              ? colors.secondary
                              : colors.border
                          }
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
                    color={colors.white}
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
              <Ionicons name="time-outline" size={30} color={colors.warning} />
              <Text style={styles.unavailableTitle}>
                Registration temporarily unavailable
              </Text>
              <Text style={styles.unavailableText}>
                The admin has not enabled AFA registration yet. Please check
                back later.
              </Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {paymentVisible && pendingRegistration && Platform.OS !== "web" && (
        <Modal visible animationType="slide">
          <WebView
            source={{
              html: mobilePaymentHtml({
                key: publicKey,
                email: user?.email || "",
                reference: pendingRegistration.payment_reference,
                amount: Number(pendingRegistration.fee_amount),
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
    </SafeAreaView>
  );
}

function ActiveInfo({ icon, label, value }) {
  return (
    <View style={styles.activeInfoItem}>
      <View style={styles.activeInfoRow}>
        <Ionicons
          name={icon}
          size={14}
          color={colors.secondary}
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
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, multiline && styles.multilineWrap]}>
        <Ionicons name={icon} size={19} color={colors.secondary} />
        <TextInput
          {...props}
          multiline={multiline}
          style={[styles.input, multiline && styles.multilineInput]}
          placeholderTextColor="#8A9A9D"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.light },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 14,
    backgroundColor: colors.white,
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.light,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCopy: { flex: 1, marginLeft: 12 },
  eyebrow: {
    color: colors.secondary,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  title: { color: colors.dark, fontSize: 22, fontWeight: "900", marginTop: 2 },
  headerMark: {
    width: 43,
    height: 43,
    borderRadius: 14,
    backgroundColor: colors.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  headerMarkText: { color: colors.white, fontSize: 12, fontWeight: "900" },
  content: { padding: 18, paddingBottom: 40 },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
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
  heroTitle: { color: colors.white, fontSize: 18, fontWeight: "900" },
  heroText: {
    color: "rgba(255,255,255,.8)",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  feeCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#eaf6ef",
    borderColor: "#c7e5d3",
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
  },
  feeLabel: {
    color: colors.secondary,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.8,
  },
  feeNote: { color: colors.secondary, fontSize: 10, marginTop: 3 },
  feeAmount: { color: colors.secondary, fontSize: 22, fontWeight: "900" },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: 22,
    padding: 17,
    marginBottom: 16,
    elevation: 2,
    shadowColor: "#002f30",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 9,
  },
  sectionTitle: {
    color: colors.dark,
    fontSize: 17,
    fontWeight: "900",
  },
  formHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 17,
  },
  formHeaderCopy: { flex: 1 },
  sectionSubtitle: {
    color: colors.dark,
    opacity: 0.55,
    fontSize: 11,
    marginTop: 3,
  },
  closeFormButton: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light,
  },
  fieldGroup: { marginBottom: 15 },
  label: {
    color: colors.dark,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 7,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 13,
    backgroundColor: colors.light,
    paddingHorizontal: 12,
  },
  multilineWrap: { alignItems: "flex-start", paddingTop: 12 },
  input: {
    flex: 1,
    color: colors.dark,
    fontSize: 15,
    paddingVertical: 12,
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
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
  },
  idTypeButtonActive: {
    backgroundColor: "#eaf6ef",
    borderColor: colors.secondary,
  },
  idTypeText: {
    color: colors.dark,
    fontSize: 12,
    fontWeight: "700",
    marginLeft: 6,
  },
  idTypeTextActive: { color: colors.secondary },
  payButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.secondary,
    borderRadius: 15,
    paddingVertical: 16,
  },
  payButtonText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "900",
    marginLeft: 8,
  },
  disabled: { opacity: 0.6 },
  unavailable: {
    backgroundColor: colors.white,
    borderRadius: 20,
    alignItems: "center",
    padding: 28,
  },
  unavailableTitle: {
    color: colors.dark,
    fontSize: 17,
    fontWeight: "900",
    marginTop: 12,
  },
  unavailableText: {
    color: colors.dark,
    opacity: 0.6,
    textAlign: "center",
    marginTop: 7,
    lineHeight: 20,
  },
  activeCard: {
    backgroundColor: colors.white,
    borderRadius: 24,
    padding: 17,
    borderWidth: 1,
    borderColor: "#cfe8d8",
    elevation: 3,
    shadowColor: colors.secondary,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
  },
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
    backgroundColor: colors.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  activeAvatarText: { color: colors.white, fontSize: 18, fontWeight: "900" },
  activeIdentityCopy: { flex: 1, marginLeft: 11 },
  activeName: { color: colors.dark, fontSize: 16, fontWeight: "900" },
  activePhone: { color: colors.secondary, fontSize: 11, marginTop: 3 },
  activeStatus: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#eaf6ef",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
    marginRight: 5,
  },
  activeStatusText: {
    color: colors.secondary,
    fontSize: 10,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  activeDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 14,
    opacity: 0.65,
  },
  activeInfoGrid: { flexDirection: "row", flexWrap: "wrap" },
  activeInfoItem: { width: "50%", paddingVertical: 7, paddingRight: 8 },
  activeInfoRow: { flexDirection: "row", alignItems: "center" },
  activeInfoIcon: { marginRight: 5 },
  activeInfoLabel: { color: colors.border, fontSize: 10 },
  activeInfoValue: {
    color: colors.dark,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 2,
    marginLeft: 24,
  },
  activeReference: {
    backgroundColor: colors.light,
    borderRadius: 12,
    padding: 10,
    marginTop: 12,
  },
  activeReferenceLabel: {
    color: colors.border,
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.7,
  },
  activeReferenceValue: {
    color: colors.secondary,
    fontSize: 11,
    fontWeight: "800",
    marginTop: 4,
  },
  requestAnotherButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#eaf6ef",
    borderColor: "#c7e5d3",
    borderWidth: 1,
    borderRadius: 15,
    padding: 12,
    marginTop: 12,
  },
  requestAnotherIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  requestAnotherCopy: { flex: 1, marginHorizontal: 10 },
  requestAnotherTitle: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: "900",
  },
  requestAnotherText: { color: colors.secondary, fontSize: 10, marginTop: 2 },
});
