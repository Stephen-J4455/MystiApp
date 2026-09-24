import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Modal,
  Platform,
  StatusBar,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase, getPaystackPublicKey } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import colors from "../components/theme";
import { getEdgeFunctionName } from "../lib/env";
import { WebView } from "react-native-webview";
import { usePaystackPayment } from "../hooks/usePaystackPayment";
import {
  fetchPaymentChargeSettings,
  getTransactionChargeAmount,
} from "../lib/paymentSettings";

// Escape user-controlled strings before interpolating into inline JS / HTML
// to prevent injection (e.g. breaking out of a quoted string with a `'`).
const escapeJs = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
};

const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u003C")
    .replace(/>/g, "\u003E")
    .replace(/"/g, "\u0022")
    .replace(/'/g, "\u0027");
};

const generatePaystackHTML = (
  amount,
  email,
  reference,
  subaccountCode,
  recipientName,
  recipientLabel,
  paystackPublicKey,
) => {
  const paystackKey = escapeJs(paystackPublicKey || "");
  const safeEmail = escapeJs(email);
  const safeRef = escapeJs(reference);
  const safeSub = subaccountCode ? escapeJs(subaccountCode) : "";
  const paystackSub = safeSub ? ",subaccount:'" + safeSub + "'" : "";
  const jsBody =
    "document.getElementById('pay-btn').onclick=function(){var b=this;b.disabled=true;var started=Date.now();var open=function(){if(!window.PaystackPop){if(Date.now()-started<10000){setTimeout(open,100);return;}window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'Paystack payment service did not load'}));b.disabled=false;return;}var o={" +
    "key:'" +
    paystackKey +
    "'," +
    "email:'" +
    safeEmail +
    "'," +
    "amount:" +
    Math.round(amount * 100) +
    "," +
    "currency:'GHS'," +
    "ref:'" +
    safeRef +
    "'" +
    paystackSub +
    ",callback:function(r){window.ReactNativeWebView.postMessage(JSON.stringify({type:'success',data:r}))}," +
    "onClose:function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'cancel'}))}};" +
    "try{var handler=PaystackPop.setup(o);handler.openIframe()}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:e&&e.message?e.message:'Paystack could not be opened'}));b.disabled=false;}};open();}";
  const safeRecipientLabel = escapeHtml(recipientLabel || "Business");
  return (
    '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Paystack Payment</title><script src="https://js.paystack.co/v1/inline.js" onerror="window.ReactNativeWebView.postMessage(JSON.stringify({type:\'error\',message:\'Could not load Paystack payment service\'}))"></scr' +
    "ipt>" +
    '<style>:root{--primary:#006769;--secondary:#2B5F1F;--accent:#40A578}body{margin:0;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}.container{background:#fff;padding:0;width:100%;height:100vh;box-shadow:none;text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center}.icon-box{width:70px;height:70px;background-color:#e6f7f7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}.icon{font-size:32px;color:var(--primary)}.title{font-size:22px;font-weight:800;color:#1A1A1A;margin-bottom:12px}.subtitle{font-size:14px;color:#666;margin-bottom:30px;line-height:1.5}.amt-box{background:#f7f9fa;padding:20px;border-radius:16px;margin-bottom:35px;border:1px solid #eee}.amt-label{font-size:13px;font-weight:600;color:var(--primary);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}.amt-val{font-size:32px;font-weight:900;color:#1A1A1A}.pay-btn{width:100%;padding:18px;background:linear-gradient(to right,var(--primary),var(--accent));color:#fff;border:none;border-radius:16px;font-size:16px;font-weight:700;cursor:pointer}.cancel-btn{margin-top:20px;padding:10px 20px;color:#888;background:none;border:none;font-size:14px;font-weight:600;cursor:pointer}.secure-note{margin-top:30px;font-size:11px;color:#aaa}</style>' +
    '</head><body><div class="container"><div class="icon-box"><span class="icon">&#x1F4BC;</span></div><h2 class="title">Wallet Top-up</h2><p class="subtitle">Complete your wallet top-up.</p><div class="amt-box"><div class="amt-label">Top-up Amount</div><div class="amt-val">GHS ' +
    amount.toFixed(2) +
    "</div>" +
    (recipientName
      ? '<div class="amt-label" style="margin-top:6px;font-size:11px;color:#888;">' +
        safeRecipientLabel +
        '</div><div class="amt-val" style="font-size:15px;font-weight:700;color:#333;">' +
        escapeHtml(recipientName) +
        "</div>"
      : "") +
    '</div><button id="pay-btn" class="pay-btn">Pay with Paystack</button>' +
    '<button onclick="window.ReactNativeWebView.postMessage(JSON.stringify({type:\'cancel\'}))" class="cancel-btn">Cancel</button>' +
    '<div class="secure-note">Secure Transaction by Paystack</div></div><script>' +
    jsBody +
    "</sc" +
    "ript></body></html>"
  );
};

export default function WalletTopUpScreen({ navigation }) {
  const { showError, showSuccess } = useNotification();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [paystackModalVisible, setPaystackModalVisible] = useState(false);
  const [currentReference, setCurrentReference] = useState("");
  const [currentBalance, setCurrentBalance] = useState(0);
  const [businessName, setBusinessName] = useState("");
  const [superAgentName, setSuperAgentName] = useState("");
  const [isSuperAgentUser, setIsSuperAgentUser] = useState(false);
  const [subaccountCode, setSubaccountCode] = useState(null);
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const paymentCompletedRef = useRef(false);
  const [webPaymentRequested, setWebPaymentRequested] = useState(false);
  const [paystackPublicKey, setPaystackPublicKey] = useState("");
  const [paystackKeyError, setPaystackKeyError] = useState(false);
  const [paymentChargeSettings, setPaymentChargeSettings] = useState({
    normalUserPercent: 1.95,
    superAgentPercent: 1.95,
    walletTopUpPercent: 1.95,
  });
  const [grossTopUpAmount, setGrossTopUpAmount] = useState(0);
  const predefinedAmounts = [50, 100, 200, 500, 1000];
  const MIN_AMOUNT = 5;
  const MAX_AMOUNT = 5000;

  useEffect(() => {
    let active = true;

    const loadSettings = async () => {
      try {
        const settings = await fetchPaymentChargeSettings();
        if (!active) return;
        setPaymentChargeSettings(settings);
      } catch (error) {
        console.warn(
          "Failed to load payment charge settings for wallet top-up:",
          error,
        );
      }
    };

    loadSettings();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadPaystackPublicKey = async () => {
      try {
        const key = await getPaystackPublicKey();
        if (!active) return;
        if (key) {
          setPaystackPublicKey(key);
        } else {
          setPaystackKeyError(true);
          console.error(
            "Paystack public key unavailable. Ensure the Paystack secret keys are configured in the edge function secrets.",
          );
        }
      } catch (err) {
        if (active) {
          setPaystackKeyError(true);
          console.error("Failed to load Paystack public key:", err);
        }
      }
    };
    loadPaystackPublicKey();
    return () => {
      active = false;
    };
  }, []);

  const handlePaymentSuccess = useCallback(
    async (response) => {
      console.log("Wallet topup payment successful:", response);
      paymentCompletedRef.current = true;
      setPaystackModalVisible(false);
      setPaymentCompleted(true);
      const paidReference =
        response?.reference || response?.trxref || currentReference;
      try {
        const { data: result, error } = await supabase.functions.invoke(
          getEdgeFunctionName("verify-wallet-topup"),
          {
            body: { reference: paidReference },
          },
        );
        if (error) {
          console.error("Verify-wallet-topup error:", error);
          showError(
            "Verification Failed",
            "Please contact support if amount was debited",
          );
          return;
        }
        if (result && result.success && !result.already_processed) {
          showSuccess(
            "Top-up Successful!",
            `Your wallet has been credited with Ghc ${parseFloat(amount)}`,
          );
          if (result.new_balance !== undefined)
            setCurrentBalance(result.new_balance);
          setAmount("");
          setCurrentReference("");
          setBusinessName("");
        } else if (result && result.already_processed) {
          // Edge function already credited this reference; just refresh UI.
          if (result.new_balance !== undefined)
            setCurrentBalance(result.new_balance);
          setAmount("");
          setCurrentReference("");
          setBusinessName("");
        } else {
          showError(
            "Verification Failed",
            "Please contact support if amount was debited",
          );
        }
      } catch (error) {
        console.error("Verification error:", error);
        showError("Verification Error", "Please contact support");
      }
    },
    [currentReference, amount, showError, showSuccess],
  );

  const handlePaymentClose = useCallback(() => {
    console.log("Wallet topup payment cancelled");
    setPaystackModalVisible(false);
    // Only notify if the user actually cancelled (not after a successful payment).
    if (!paymentCompletedRef.current) {
      showError("Payment Cancelled", "Top-up was not completed");
    }
    paymentCompletedRef.current = false;
    setPaymentCompleted(false);
  }, [showError]);

  const webPaystackConfig = useMemo(() => {
    if (Platform.OS !== "web" || !currentReference || !userEmail) {
      return null;
    }
    return {
      publicKey: paystackPublicKey,
      email: userEmail,
      amount: Math.round(grossTopUpAmount * 100),
      currency: "GHS",
      reference: currentReference,
      subaccount: subaccountCode || null,
      onSuccess: handlePaymentSuccess,
      onClose: handlePaymentClose,
    };
  }, [
    currentReference,
    userEmail,
    grossTopUpAmount,
    paystackPublicKey,
    subaccountCode,
    handlePaymentSuccess,
    handlePaymentClose,
  ]);

  const { initializePayment } = usePaystackPayment(webPaystackConfig);

  useEffect(() => {
    if (
      Platform.OS !== "web" ||
      !webPaymentRequested ||
      !webPaystackConfig ||
      !paystackPublicKey
    ) {
      return;
    }

    setWebPaymentRequested(false);
    initializePayment();
  }, [
    webPaymentRequested,
    webPaystackConfig,
    paystackPublicKey,
    initializePayment,
  ]);

  const fetchUserData = useCallback(async () => {
    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError || !user) {
        showError("Authentication Error", "Please log in");
        return;
      }
      setUserEmail(user.email);
      // business_name lives on auth.users.user_metadata, not on agent_wallet.
      const metaBusinessName =
        user?.user_metadata?.business_name ||
        user?.app_metadata?.business_name ||
        "";
      setBusinessName(metaBusinessName);
      const normalizedRole = String(
        user?.user_metadata?.role || user?.app_metadata?.role || "",
      ).toLowerCase();
      const isSuperAgentRole =
        normalizedRole === "superagent" || normalizedRole === "super_agent";
      if (!isSuperAgentRole) {
        showError(
          "Access denied",
          "Only Super Agents can fund an operational wallet.",
        );
        navigation.goBack();
        return;
      }
      setIsSuperAgentUser(true);

      // Resolve the super agent's Paystack subaccount so wallet top-ups can be
      // routed to the Super Agent settlement account.
      // The super agent's business name lives on super_agent_paystack.business_name.
      const superAgentId =
        user?.user_metadata?.super_agent_id ||
        user?.app_metadata?.super_agent_id ||
        null;
      if (superAgentId) {
        try {
          const { data: subaccountRow } = await supabase
            .from("super_agent_paystack")
            .select("subaccount_code, is_active, business_name")
            .eq("super_agent_id", superAgentId)
            .maybeSingle();
          if (subaccountRow?.is_active && subaccountRow.subaccount_code) {
            setSubaccountCode(subaccountRow.subaccount_code);
            // Prefer the super agent's business name from the subaccount row
            // so the Paystack page shows who the payment is going to.
            if (subaccountRow.business_name) {
              setSuperAgentName(subaccountRow.business_name);
            }
          }
        } catch (subaccountError) {
          console.warn(
            "Could not resolve super-agent subaccount:",
            subaccountError,
          );
        }
      }

      const { data: wallet, error: walletError } = await supabase
        .from("super_agent_wallets")
        .select("balance")
        .eq("super_agent_id", user.id)
        .maybeSingle();
      if (walletError) {
        console.error("Super Agent wallet fetch error:", walletError);
      } else if (wallet) {
        setCurrentBalance(wallet.balance || 0);
      }
    } catch (error) {
      console.error("Fetch user data err:", error);
    }
  }, [showError]);

  useEffect(() => {
    let walletSubscription = null;
    const setupWalletRealtime = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          walletSubscription = supabase
            .channel("super_agent_wallet_balance_realtime")
            .on(
              "postgres_changes",
              {
                event: "UPDATE",
                schema: "public",
                table: "super_agent_wallets",
                filter: `super_agent_id=eq.${user.id}`,
              },
              (payload) => {
                setCurrentBalance(payload.new.balance || 0);
              },
            )
            .subscribe();
        }
      } catch (error) {
        console.error("Setup realtime err:", error);
      }
    };
    fetchUserData();
    setupWalletRealtime();
    return () => {
      if (walletSubscription) supabase.removeChannel(walletSubscription);
    };
  }, [fetchUserData]);

  const handleAmountSelect = (val) => {
    setAmount(val.toString());
  };

  const handleTopUp = async () => {
    const numericAmount = parseFloat(amount);
    if (!amount || Number.isNaN(numericAmount)) {
      showError("Invalid Amount", "Please enter a valid amount");
      return;
    }
    if (numericAmount < MIN_AMOUNT) {
      showError("Invalid Amount", `Minimum top-up is Ghc ${MIN_AMOUNT}`);
      return;
    }
    if (numericAmount > MAX_AMOUNT) {
      showError(
        "Invalid Amount",
        `Maximum top-up is Ghc ${MAX_AMOUNT.toLocaleString()}`,
      );
      return;
    }
    setLoading(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        showError("Authentication Error", "Please log in");
        setLoading(false);
        return;
      }

      const chargeFee = getTransactionChargeAmount(
        numericAmount,
        paymentChargeSettings.walletTopUpPercent,
      );
      const grossAmount = Number((numericAmount + chargeFee).toFixed(2));

      const reference = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      const { error: insertError } = await supabase
        .from("wallet_topups")
        .insert({
          agent_id: user.id,
          amount: numericAmount,
          reference,
          status: "pending",
        });

      if (insertError) {
        console.error("Failed to create wallet_topups row:", insertError);
        showError("Error", "Failed to create payment reference");
        setLoading(false);
        return;
      }

      setCurrentReference(reference);
      setGrossTopUpAmount(grossAmount);
      paymentCompletedRef.current = false;
      setPaymentCompleted(false);
      if (Platform.OS === "web") {
        setWebPaymentRequested(true);
      } else {
        setPaystackModalVisible(true);
      }
    } catch (error) {
      console.error("Top-up error:", error);
      showError("Error", "Please try again");
    }
    setLoading(false);
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
      <SafeAreaView style={styles.safeArea} edges={["top"]}>
        <TouchableOpacity
          style={styles.floatingBackButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={20} color="#333" />
        </TouchableOpacity>
        <KeyboardAwareScrollView
          style={styles.content}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.title}>
              {isSuperAgentUser ? "Super Agent Wallet" : "Wallet Top-up"}
            </Text>
            <Text style={styles.subtitle}>
              Add funds to your wallet to start serving customers
            </Text>
          </View>
          <View style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>Current Balance</Text>
            <Text style={styles.balanceAmount}>
              Ghc {currentBalance.toFixed(2)}
            </Text>
          </View>
          <View>
            <Text style={styles.sectionTitle}>Quick Select</Text>
            <View style={styles.amountGrid}>
              {predefinedAmounts.map((preset) => (
                <TouchableOpacity
                  key={preset}
                  style={[
                    styles.amountChip,
                    amount === preset.toString() && styles.amountChipSelected,
                  ]}
                  onPress={() => handleAmountSelect(preset)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.amountChipText,
                      amount === preset.toString() &&
                        styles.amountChipTextSelected,
                    ]}
                  >
                    Ghc {preset}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.sectionTitle}>Or Enter Amount</Text>
            <View style={styles.inputWrapper}>
              <View style={styles.currencyPrefix}>
                <Text style={styles.currencyText}>GH&#755;</Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder="Enter amount"
                value={amount}
                onChangeText={setAmount}
                keyboardType="numeric"
                placeholderTextColor="#999"
              />
            </View>
            <View style={styles.limitInfo}>
              <View style={styles.limitItem}>
                <Ionicons
                  name="information-circle-outline"
                  size={16}
                  color={colors.textSecondary}
                />
                <Text style={styles.limitText}>Min: Ghc 5</Text>
              </View>
              <View style={styles.limitItem}>
                <Ionicons
                  name="information-circle-outline"
                  size={16}
                  color={colors.textSecondary}
                />
                <Text style={styles.limitText}>Max: Ghc 5,000</Text>
              </View>
            </View>
            <TouchableOpacity
              style={[styles.payButton, !amount && styles.payButtonDisabled]}
              onPress={handleTopUp}
              disabled={!amount || loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <Text style={styles.payButtonText}>Processing...</Text>
              ) : (
                <Text style={styles.payButtonText}>Proceed to Pay</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAwareScrollView>
        {Platform.OS !== "web" && (
          <Modal
            visible={paystackModalVisible}
            transparent
            animationType="slide"
            onRequestClose={handlePaymentClose}
          >
            <View style={styles.modalOverlay}>
              <View style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Complete Payment</Text>
                  <TouchableOpacity
                    onPress={handlePaymentClose}
                    style={styles.closeButton}
                  >
                    <Ionicons
                      name="close"
                      size={24}
                      color={colors.textSecondary}
                    />
                  </TouchableOpacity>
                </View>
                <View style={styles.webviewContainer}>
                  {paystackKeyError && (
                    <View style={styles.webviewError}>
                      <Ionicons
                        name="alert-circle-outline"
                        size={48}
                        color={colors.danger}
                      />
                      <Text style={styles.webviewErrorText}>
                        Payment configuration not available
                      </Text>
                      <Text style={styles.webviewErrorSubtext}>
                        Paystack public key could not be loaded. Ensure Paystack
                        secrets are configured on the server.
                      </Text>
                    </View>
                  )}
                  {currentReference && userEmail && amount && (
                    <WebView
                      source={{
                        html: generatePaystackHTML(
                          grossTopUpAmount || parseFloat(amount),
                          userEmail,
                          currentReference,
                          subaccountCode,
                          // Show the super agent (recipient of the payment) when
                          // a subaccount is resolved; otherwise fall back to the
                          // current user's business name.
                          subaccountCode && superAgentName
                            ? superAgentName
                            : businessName,
                          subaccountCode && superAgentName
                            ? "Super Agent"
                            : "Business",
                          paystackPublicKey,
                        ),
                      }}
                      javaScriptEnabled
                      domStorageEnabled
                      userAgent="Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.106 Mobile Safari/537.36"
                      scalesPageToFit
                      thirdPartyCookiesEnabled
                      sharedCookiesEnabled
                      mixedContentMode="always"
                      setSupportMultipleWindows={false}
                      startInLoadingState
                      originWhitelist={["*"]}
                      onMessage={(event) => {
                        try {
                          const m = JSON.parse(event.nativeEvent.data);
                          if (m.type === "success")
                            handlePaymentSuccess(m.data);
                          else if (m.type === "cancel") handlePaymentClose();
                          else if (m.type === "error") {
                            console.error("Paystack WebView error:", m.message);
                            showError(
                              "Payment Error",
                              m.message ||
                                "Could not initialize Paystack payment.",
                            );
                          }
                        } catch (e) {
                          console.error("Webview msg err:", e);
                        }
                      }}
                      onError={(syntheticEvent) => {
                        console.error(
                          "WebView error:",
                          syntheticEvent.nativeEvent,
                        );
                        showError(
                          "Payment Error",
                          "Could not load payment page. Please try again.",
                        );
                        handlePaymentClose();
                      }}
                      onHttpError={(syntheticEvent) => {
                        console.error(
                          "WebView HTTP error:",
                          syntheticEvent.nativeEvent,
                        );
                      }}
                      renderError={(errorName) => (
                        <View style={styles.webviewError}>
                          <Ionicons
                            name="alert-circle-outline"
                            size={48}
                            color={colors.danger}
                          />
                          <Text style={styles.webviewErrorText}>
                            Failed to load payment page
                          </Text>
                          <Text style={styles.webviewErrorSubtext}>
                            {errorName}
                          </Text>
                        </View>
                      )}
                      style={styles.webview}
                    />
                  )}
                </View>
              </View>
            </View>
          </Modal>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  safeArea: { flex: 1 },
  flex: { flex: 1 },
  floatingBackButton: {
    position: "absolute",
    top: 50,
    left: 16,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#FFF",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  header: { paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16 },
  title: { fontSize: 28, fontWeight: "800", color: "#1A1A1A", marginBottom: 8 },
  subtitle: { fontSize: 14, color: "#666", lineHeight: 20 },
  balanceCard: {
    marginHorizontal: 20,
    marginBottom: 24,
    padding: 24,
    borderRadius: 20,
    backgroundColor: "#F0FAFA",
    borderWidth: 1,
    borderColor: "#D0F0F0",
  },
  balanceLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.primary,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 8,
  },
  balanceAmount: { fontSize: 36, fontWeight: "900", color: "#1A1A1A" },
  content: { flex: 1 },
  scrollContent: { padding: 20 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1A1A1A",
    marginBottom: 12,
    marginTop: 8,
  },
  amountGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 20,
  },
  amountChip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#F5F5F5",
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  amountChipSelected: {
    backgroundColor: "#E6F7F7",
    borderColor: colors.primary,
  },
  amountChipText: { fontSize: 14, fontWeight: "600", color: "#555" },
  amountChipTextSelected: { color: colors.primary, fontWeight: "700" },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F8F9FA",
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: "#E0E0E0",
    marginBottom: 16,
    overflow: "hidden",
  },
  currencyPrefix: {
    paddingHorizontal: 16,
    borderRightWidth: 1,
    borderRightColor: "#E0E0E0",
    paddingVertical: 16,
  },
  currencyText: { fontSize: 16, fontWeight: "700", color: colors.primary },
  input: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 16,
    fontSize: 18,
    fontWeight: "600",
    color: "#1A1A1A",
  },
  limitInfo: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 24,
    paddingHorizontal: 4,
  },
  limitItem: { flexDirection: "row", alignItems: "center" },
  limitText: { fontSize: 12, color: colors.textSecondary, marginLeft: 4 },
  payButton: {
    backgroundColor: colors.primary,
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: "center",
    marginBottom: 40,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  payButtonDisabled: { backgroundColor: "#CCC", shadowOpacity: 0.1 },
  payButtonText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#FFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "85%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: "#1A1A1A" },
  closeButton: { padding: 4 },
  webviewContainer: { height: 600 },
  webview: { backgroundColor: "#FFF" },
  webviewError: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  webviewErrorText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1A1A1A",
    marginTop: 12,
  },
  webviewErrorSubtext: {
    fontSize: 13,
    color: "#888",
    marginTop: 4,
    textAlign: "center",
  },
});
