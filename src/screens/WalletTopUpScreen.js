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
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { supabase, getPaystackPublicKey } from "../lib/supabase";
import { removeChannelSafe, uniqueTopic } from "../lib/realtime";
import { useNotification } from "../contexts/NotificationContext";
import { fonts } from "../components/theme";
import { getEdgeFunctionName } from "../lib/env";
import { retainsWallet } from "../lib/superAgent";
import { WebView } from "react-native-webview";
import { usePaystackPayment } from "../hooks/usePaystackPayment";
import { ThemedScreen, themedStyles } from "../components/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../contexts/ThemeContext";
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
  c,
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
    "<style>:root{--primary:" +
    c.mintDim +
    ";--accent:" +
    c.mint +
    '}body{margin:0;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:' +
    c.canvas +
    ";display:flex;justify-content:center;align-items:center;min-height:100vh}.container{background:" +
    c.canvas +
    ";padding:0;width:100%;height:100vh;box-shadow:none;text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center}.icon-box{width:70px;height:70px;background-color:" +
    c.surfaceHover +
    ";border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}.icon{font-size:32px;color:var(--primary)}.title{font-size:22px;font-weight:800;color:" +
    c.textPrimary +
    ";margin-bottom:12px}.subtitle{font-size:14px;color:" +
    c.textSecondary +
    ";margin-bottom:30px;line-height:1.5}.amt-box{background:" +
    c.surface +
    ";padding:20px;border-radius:16px;margin-bottom:35px;border:1px solid " +
    c.hairline +
    "}.amt-label{font-size:13px;font-weight:600;color:var(--primary);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}.amt-val{font-size:32px;font-weight:900;color:" +
    c.textPrimary +
    "}.pay-btn{width:100%;padding:18px;background:linear-gradient(to right,var(--primary),var(--accent));color:" +
    c.onAccent +
    ";border:none;border-radius:999px;font-size:16px;font-weight:700;cursor:pointer}.cancel-btn{margin-top:20px;padding:10px 20px;color:" +
    c.textMuted +
    ";background:none;border:none;font-size:14px;font-weight:600;cursor:pointer}.secure-note{margin-top:30px;font-size:11px;color:" +
    c.textMuted +
    "}</style>" +
    '</head><body><div class="container"><div class="icon-box"><span class="icon">&#x1F4BC;</span></div><h2 class="title">Wallet Top-up</h2><p class="subtitle">Complete your wallet top-up.</p><div class="amt-box"><div class="amt-label">Top-up Amount</div><div class="amt-val">GHS ' +
    amount.toFixed(2) +
    "</div>" +
    (recipientName
      ? '<div class="amt-label" style="margin-top:6px;font-size:11px;color:' +
        c.textMuted +
        ';">' +
        safeRecipientLabel +
        '</div><div class="amt-val" style="font-size:15px;font-weight:700;color:' +
        c.textSecondary +
        ';">' +
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
  const theme = useTheme();
  const c = theme.c;
  // Edge-to-edge on Android with no navigator header - see ProfileScreen.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const styles = useWalletTopUpStyles(c, topInset);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [paystackModalVisible, setPaystackModalVisible] = useState(false);
  const [currentReference, setCurrentReference] = useState("");
  const [currentBalance, setCurrentBalance] = useState(0);
  const [businessName, setBusinessName] = useState("");
  const [superAgentName, setSuperAgentName] = useState("");
  const [isSuperAgentUser, setIsSuperAgentUser] = useState(false);
  // A demoted Super Agent who still owns a wallet row. They get a read-only
  // view of their balance; funding stays blocked, because
  // `verify-payment` will not let a non-super-agent spend it.
  const [isFormerSuperAgent, setIsFormerSuperAgent] = useState(false);
  // A SUB-AGENT funding their super agent's wallet. Distinct from
  // `isSuperAgentUser`: this account does NOT own the wallet, cannot spend
  // from it, and is spending real money into someone else's balance - so the
  // screen says so instead of showing a generic "Top up".
  const [fundsSuperAgent, setFundsSuperAgent] = useState(false);
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
          // The server recomputed and verified the split, so quote ITS figures
          // rather than the locally-computed `amount`. They agree today, but the
          // local value is a pre-payment estimate made with a possibly stale
          // rate - and this is the one place the user is told what they were
          // actually charged.
          const credited = Number(
            result.credited_amount ?? parseFloat(amount) ?? 0,
          );
          const charge = Number(result.charge_amount || 0);
          const gross = Number(result.gross_amount || 0);
          const percent = Number(result.charge_percent || 0);

          // A sub-agent's top-up is credited to their SUPER AGENT's wallet as
          // real money, AND raises the sub-agent's own available balance by the
          // same figure - it is their spending power, not a second pot.
          //
          // So this is no longer "their money went to someone else and you got
          // nothing". It is: your payment funds their wallet, and your own
          // available balance rises by the same amount. `new_balance` is the
          // SUPER AGENT's real balance and must never be written into this
          // screen's balance; `sub_agent_balance` is the payer's own.
          const creditedToSuperAgent = Boolean(result.funded_someone_else);
          const balanceLine =
            charge > 0
              ? `Ghc ${credited.toFixed(2)} after a ${percent}% Paystack charge of Ghc ${charge.toFixed(2)} (Ghc ${gross.toFixed(2)} paid).`
              : `Ghc ${credited.toFixed(2)}`;

          showSuccess(
            "Top-up Successful!",
            creditedToSuperAgent
              ? `Your available balance rose by ${balanceLine} ${superAgentName || "Your Super Agent"}'s wallet was funded with the same amount.`
              : `Your wallet has been credited with ${balanceLine}`,
          );
          // The payer's own balance, from `sub_agent_balance`. Falls back to a
          // refresh-free no-op rather than the super agent's figure, which
          // would display another person's money as the payer's.
          if (
            creditedToSuperAgent &&
            result.sub_agent_balance !== null &&
            result.sub_agent_balance !== undefined
          ) {
            setCurrentBalance(Number(result.sub_agent_balance));
          } else if (
            !creditedToSuperAgent &&
            result.new_balance !== undefined
          ) {
            setCurrentBalance(result.new_balance);
          }
          setAmount("");
          setCurrentReference("");
          setBusinessName("");
        } else if (result && result.already_processed) {
          // Edge function already credited this reference; just refresh UI.
          // Same ownership rule: only overwrite a balance this account owns.
          if (result.funded_someone_else) {
            if (
              result.sub_agent_balance !== null &&
              result.sub_agent_balance !== undefined
            ) {
              setCurrentBalance(Number(result.sub_agent_balance));
            }
          } else if (result.new_balance !== undefined) {
            setCurrentBalance(result.new_balance);
          }
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
    [currentReference, amount, superAgentName, showError, showSuccess],
  );

  const handlePaymentClose = useCallback(() => {
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

      // A demoted Super Agent keeps their wallet. `super_agent_wallets` is
      // keyed on `super_agent_id` and its RLS is `super_agent_id =
      // auth.uid()` with NO role term, so the balance is still theirs to read
      // and re-reading it here shows it rather than hiding money they earned.
      //
      // The wallet row is fetched BEFORE the role gate below, because it is
      // what decides whether there is anything to show.
      const { data: wallet, error: walletError } = await supabase
        .from("super_agent_wallets")
        .select("super_agent_id, balance")
        .eq("super_agent_id", user.id)
        .maybeSingle();
      if (walletError) {
        console.error("Super Agent wallet fetch error:", walletError);
      } else if (wallet) {
        setCurrentBalance(wallet.balance || 0);
      }

      // Resolve the funding target from `public.user_profiles`, NOT from
      // `user_metadata`. `user_metadata.role` is writable by the account owner
      // via `auth.updateUser({ data: { role: 'super_agent' } })`, so reading
      // it to decide "whose wallet does this money land in" would let anyone
      // nominate a wallet they have no relationship to. The edge function reads
      // the same table with the same precedence, so this is a display-only
      // mirror of an authority that is enforced server-side either way.
      const { data: profile, error: profileError } = await supabase
        .from("user_profiles")
        .select("role, super_agent_id, full_name")
        .eq("id", user.id)
        .maybeSingle();
      if (profileError) {
        console.error("Profile fetch error:", profileError);
      }

      const profileRole = String(profile?.role || "").toLowerCase();
      const assignedSuperAgentId = profile?.super_agent_id || null;
      const assignedSuperAgentName = profile?.full_name || "";

      // A sub-agent funds their super agent ONLY when the server-authoritative
      // profile says so. `profileError` fails closed: an unreadable profile
      // leaves both flags false, so the gate below refuses rather than
      // guessing a destination for the money.
      const subAgentFundsSuperAgent =
        !isSuperAgentRole &&
        (profileRole === "sub_agent" || profileRole === "subagent") &&
        Boolean(assignedSuperAgentId) &&
        assignedSuperAgentId !== user.id;

      if (!isSuperAgentRole) {
        // A NORMAL USER IS REFUSED, and refused FIRST - before the wallet row
        // is even read.
        //
        // A normal user cannot own a wallet: `verify-wallet-topup` rejects their
        // payment outright because they have no super agent for the money to
        // fund, so any `super_agent_wallets` row that exists for them is not
        // theirs to see. The previous code read the row first and only fell
        // through to the generic "Access denied" afterwards, which meant the
        // read still happened and a stray row would have been loaded into state
        // before the redirect.
        //
        // The check is on the AUTHORITATIVE profile role, not `user_metadata`:
        // `user_metadata` is writable by the account owner via
        // `auth.updateUser({ data: { role: 'super_agent' } })`, so gating on it
        // would let a normal user unlock this screen by editing their own
        // metadata.
        if (
          profileRole === "normal_user" ||
          profileRole === "normaluser" ||
          profileRole === "user"
        ) {
          console.warn(
            "[WalletTopUpScreen] Normal user reached the wallet screen; refusing.",
          );
          showError(
            "Access denied",
            "This feature is not available on your account.",
          );
          navigation.goBack();
          return;
        }

        // A SUB-AGENT can fund their super agent's wallet.
        //
        // This is a real transfer of someone else's money, so the screen has to
        // say so plainly rather than letting a generic "Top up" button imply the
        // balance is theirs. `verify-wallet-topup` credits the resolved
        // super agent, not the payer, and returns `funded_someone_else` so the
        // confirmation can name who was funded.
        //
        // A demoted ex-super-agent is different: they have no super agent to
        // fund (the ownership key is cleared on demotion), so funding would
        // have no destination. They get the read-only balance view below.
        if (retainsWallet(user, wallet)) {
          setIsSuperAgentUser(false);
          setIsFormerSuperAgent(true);
          return;
        }

        if (subAgentFundsSuperAgent) {
          setIsSuperAgentUser(false);
          setFundsSuperAgent(true);
          setSuperAgentName(assignedSuperAgentName || "your Super Agent");
          return;
        }

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
    } catch (error) {
      console.error("Fetch user data err:", error);
    }
  }, [showError]);

  useEffect(() => {
    // Created asynchronously, so it lives in a ref cleanup can reach. A
    // closure variable is still null if the effect is torn down during the
    // awaits, which leaks the channel and lets the next run collide with it.
    const walletChannelRef = { current: null };
    const setupWalletRealtime = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          walletChannelRef.current = supabase
            .channel(uniqueTopic("super_agent_wallet_balance_realtime"))
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
      removeChannelSafe(walletChannelRef.current);
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
    <ThemedScreen>
      <View style={styles.safeArea}>
        <TouchableOpacity
          style={styles.floatingBackButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={20} color={c.textPrimary} />
        </TouchableOpacity>
        <KeyboardAwareScrollView
          style={styles.content}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.title}>
              {isFormerSuperAgent
                ? "Wallet Balance"
                : isSuperAgentUser
                  ? "Super Agent Wallet"
                  : "Wallet Top-up"}
            </Text>
            <Text style={styles.subtitle}>
              {isFormerSuperAgent
                ? "Your wallet is still here, but this account can no longer fund it"
                : fundsSuperAgent
                  ? `Topping up. Ghc ${currentBalance.toFixed(2)} is your available balance, funded by your payments and spent on your orders.`
                  : "Add funds to your wallet to start serving customers"}
            </Text>
          </View>
          {fundsSuperAgent ? (
            // A SUB-AGENT NOW HAS A REAL BALANCE.
            //
            // It is a mirror of the spending power their payments bought,
            // funded against their super agent's money - not money of their own,
            // and not withdrawable. It is debited on every wallet order, which
            // is why it can legitimately be lower than what they have paid in.
            //
            // The previous version of this card claimed they held no balance at
            // all and rendered nothing, which is what made the wallet read as
            // "missing". It also has to be labelled as a limit rather than a
            // balance, because a super agent topping up more does NOT raise it -
            // only the sub-agent's own payments do.
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>Your available balance</Text>
              <Text style={styles.balanceAmount}>
                Ghc {currentBalance.toFixed(2)}
              </Text>
              <Text style={styles.balanceHint}>
                Funded by your own top-ups and spent on your orders. Not
                withdrawable, and not raised by money your Super Agent adds.
              </Text>
            </View>
          ) : (
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>Current Balance</Text>
              <Text style={styles.balanceAmount}>
                Ghc {currentBalance.toFixed(2)}
              </Text>
            </View>
          )}
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
                  color={c.textMuted}
                />
                <Text style={styles.limitText}>Min: Ghc 5</Text>
              </View>
              <View style={styles.limitItem}>
                <Ionicons
                  name="information-circle-outline"
                  size={16}
                  color={c.textMuted}
                />
                <Text style={styles.limitText}>Max: Ghc 5,000</Text>
              </View>
            </View>
            <TouchableOpacity
              style={[
                styles.payButton,
                (isFormerSuperAgent || !amount) && styles.payButtonDisabled,
              ]}
              onPress={handleTopUp}
              // A former super agent is READ ONLY. Disabling the button is the
              // honest affordance: `verify-payment` would refuse the resulting
              // order anyway, because the wallet-spend path is gated on
              // `identity.role === "super_agent"`.
              disabled={isFormerSuperAgent || !amount || loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <Text style={styles.payButtonText}>Processing...</Text>
              ) : (
                <Text
                  style={[
                    styles.payButtonText,
                    (isFormerSuperAgent || !amount) &&
                      styles.payButtonTextDisabled,
                  ]}
                >
                  {isFormerSuperAgent
                    ? "Top-up unavailable"
                    : fundsSuperAgent
                      ? "Top up"
                      : "Proceed to Pay"}
                </Text>
              )}
            </TouchableOpacity>
            {fundsSuperAgent && (
              <Text style={[styles.balanceHint, { marginTop: 10 }]}>
                The amount you pay is credited to{" "}
                {superAgentName || "your Super Agent"}'s wallet as their real
                money, and raises your available balance by the same figure. The
                1.95% charge applies to this top-up only — orders placed from
                your balance are not charged again.
              </Text>
            )}
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
                    <Ionicons name="close" size={24} color={c.textMuted} />
                  </TouchableOpacity>
                </View>
                <View style={styles.webviewContainer}>
                  {paystackKeyError && (
                    <View style={styles.webviewError}>
                      <Ionicons
                        name="alert-circle-outline"
                        size={48}
                        color={c.rose}
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
                          c,
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
                            color={c.rose}
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
      </View>
    </ThemedScreen>
  );
}

// Layered on the shared kit. Screen-specific parts are the balance card, the
// preset-amount chips and the Paystack sheet modal.
const useWalletTopUpStyles = (c, topInset = 0) => {
  const base = themedStyles(c);
  return StyleSheet.create({
    ...base,
    safeArea: { flex: 1 },
    content: { flex: 1 },
    scrollContent: { padding: 20, paddingBottom: 8 },

    // The back button is absolutely positioned and the header sits below it,
    // so both clear the Android status bar. iOS already spaces this, so the
    // inset is Android-only.
    floatingBackButton: {
      position: "absolute",
      top: 50 + topInset,
      left: 16,
      zIndex: 10,
      width: 40,
      height: 40,
      borderRadius: 999,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
      justifyContent: "center",
      alignItems: "center",
    },

    header: { paddingTop: 60 + topInset, paddingBottom: 16 },
    title: { ...base.headerTitle, fontSize: 28, marginBottom: 8 },
    subtitle: { ...base.headerSubtitle, fontSize: 14, lineHeight: 20 },

    // Balance is the headline number, so it keeps a filled treatment in both
    // schemes via the mint tint rather than a flat surface.
    balanceCard: {
      marginBottom: 24,
      padding: 24,
      borderRadius: 22,
      backgroundColor: `${c.mint}12`,
      borderWidth: 1,
      borderColor: `${c.mint}2E`,
    },
    balanceLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.mint,
      textTransform: "uppercase",
      letterSpacing: 1,
      marginBottom: 8,
    },
    balanceAmount: {
      fontFamily: fonts.display,
      fontSize: 36,
      color: c.textPrimary,
    },
    // Explains what a sub-agent's mirrored balance IS, and specifically that it
    // is a limit rather than withdrawable money. Without this the number is
    // indistinguishable from a super agent's, and the natural assumption is
    // that their own money is sitting in it.
    balanceHint: {
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 19,
      color: c.textSecondary,
      marginTop: 12,
    },

    sectionTitle: {
      fontFamily: fonts.display,
      fontSize: 16,
      color: c.textPrimary,
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
      paddingVertical: 11,
      borderRadius: 999,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    amountChipSelected: {
      backgroundColor: `${c.mint}1F`,
      borderColor: c.mint,
    },
    amountChipText: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.textSecondary,
    },
    amountChipTextSelected: { fontFamily: fonts.bodyBold, color: c.mint },

    inputWrapper: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.canvasRaised,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.hairline,
      marginBottom: 16,
      overflow: "hidden",
    },
    currencyPrefix: {
      paddingHorizontal: 16,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: c.hairline,
      paddingVertical: 17,
    },
    currencyText: { fontFamily: fonts.bodyBold, fontSize: 16, color: c.mint },
    input: {
      flex: 1,
      paddingHorizontal: 16,
      paddingVertical: 17,
      fontFamily: fonts.bodySemi,
      fontSize: 18,
      color: c.textPrimary,
    },

    limitInfo: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 24,
      paddingHorizontal: 4,
    },
    limitItem: { flexDirection: "row", alignItems: "center" },
    limitText: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textMuted,
      marginLeft: 4,
    },

    payButton: {
      backgroundColor: c.mint,
      paddingVertical: 18,
      borderRadius: 999,
      alignItems: "center",
      marginBottom: 40,
    },
    // Disabled greys the fill out rather than hiding the button, so the
    // layout does not jump when no amount is entered yet.
    payButtonDisabled: { backgroundColor: c.surfaceHover },
    payButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 16,
      color: c.onAccent,
    },
    payButtonTextDisabled: { color: c.textMuted },

    // Paystack sheet
    modalOverlay: {
      flex: 1,
      backgroundColor: c.menuBackdrop,
      justifyContent: "flex-end",
    },
    modalContent: {
      backgroundColor: c.canvasRaised,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      maxHeight: "85%",
      borderTopWidth: 1,
      borderColor: c.hairline,
    },
    modalHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.hairline,
    },
    modalTitle: {
      fontFamily: fonts.display,
      fontSize: 18,
      color: c.textPrimary,
    },
    closeButton: { padding: 4 },
    webviewContainer: { height: 600 },
    webview: { backgroundColor: c.canvas },
    webviewError: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      padding: 20,
    },
    webviewErrorText: {
      fontFamily: fonts.bodyBold,
      fontSize: 16,
      color: c.textPrimary,
      marginTop: 12,
    },
    webviewErrorSubtext: {
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textMuted,
      marginTop: 4,
      textAlign: "center",
    },
  });
};
