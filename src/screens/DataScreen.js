import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
  StyleSheet,
  TextInput,
  ImageBackground,
  Alert,
  StatusBar,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { useProfile } from "../contexts/ProfileContext";
import { useTheme } from "../contexts/ThemeContext";
import { ConfirmDialog, EmptyState } from "../components/ui";
import { fonts, networks } from "../components/theme";
import { WebView } from "react-native-webview";
import { invokeEdgeFunction } from "../lib/edgeFunctions.js";
import { Modal } from "react-native";
import { usePaystackPayment } from "../hooks/usePaystackPayment";
import { getPaystackPublicKey } from "../lib/supabase";
import { getEdgeFunctionName } from "../lib/env";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";

import {
  loadSubAgentPackages,
  formatBundleSizeFromDescriptor,
  fetchCatalogPackages,
} from "../services/superAgentService";
import {
  fetchPaymentChargeSettings,
  getTransactionChargeAmount,
} from "../lib/paymentSettings";
import { getGhanaPhoneError, sanitizeGhanaPhone } from "../lib/ghanaPhone";

// Tab order for the data-type switcher. The key must match the value returned
// by getBundleFamily in the component.
const BUNDLE_FAMILY_ORDER = [
  { key: "everyday", label: "Everyday", icon: "flash-outline" },
  { key: "ishare", label: "iShare", icon: "people-outline" },
  { key: "big_time", label: "Big Time", icon: "trending-up-outline" },
];

export default function DataScreen({ navigation, route }) {
  // Several call sites reach this screen without params (the "Browse" action,
  // the empty-state CTA, ad deep links). `route.params` is undefined there, so
  // this must not destructure directly. MTN is the default landing network -
  // it matches the hero "Buy Data" button and the first network card.
  const network = route.params?.network || "mtn";
  const { c, isDark } = useTheme();
  const s = useDataStyles(c);
  // Clears the floating bottom dock so the last bundle row stays reachable.
  const dockPadding = useDockBottomPadding(12);
  // The app is edge-to-edge on Android and this screen has no navigator header,
  // so it must inset itself below the status bar. iOS already spaces its
  // content, so the inset is only consumed there.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;

  const [selectedBundle, setSelectedBundle] = useState(null);
  const [bundles, setBundles] = useState([]);
  const [activeFamily, setActiveFamily] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paystackModalVisible, setPaystackModalVisible] = useState(false);
  const [directPaystackRequested, setDirectPaystackRequested] = useState(false);
  const [recipientModalVisible, setRecipientModalVisible] = useState(false);
  // Super agents buy straight from their own wallet: no Paystack, no
  // recoverable step. The tap on a bundle therefore debits real balance
  // immediately, so the order is held in `walletConfirm` and only released
  // once the agent explicitly confirms the cost breakdown.
  const [walletConfirm, setWalletConfirm] = useState(null);
  const [walletPurchasing, setWalletPurchasing] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [userPhone, setUserPhone] = useState("");

  // Sanitises on every keystroke so the field can only ever hold digits, and
  // folds an international number down to the 10-digit local form. Without
  // this the user can paste or type letters, spaces and a 13th digit, and the
  // value is only discovered to be wrong several taps later.
  //
  // Sanitising rather than rejecting is deliberate: a pasted
  // "0532 973 455" or "+233532973455" still produces the number the user meant
  // instead of being thrown away. `keyboardType="phone-pad"` is only a hint -
  // it does not filter pasted text - so this is what actually enforces the rule.
  const handleRecipientPhoneChange = (text) => {
    setRecipientPhone(sanitizeGhanaPhone(text));
  };
  const [purchaseType, setPurchaseType] = useState("self"); // 'self' or 'others'
  const [isAgent, setIsAgent] = useState(false);
  const [isSuperAgentUser, setIsSuperAgentUser] = useState(false);
  const [resolvedSubaccountCode, setResolvedSubaccountCode] = useState(null);
  const [paystackSubaccount, setPaystackSubaccount] = useState(null);
  const [subaccountLoading, setSubaccountLoading] = useState(false);
  const [superAgentId, setSuperAgentId] = useState(null);
  const [agentChecked, setAgentChecked] = useState(false);
  const [agentBalance, setAgentBalance] = useState(0);
  const [agentTier, setAgentTier] = useState(null);
  const [paymentChargeSettings, setPaymentChargeSettings] = useState({
    normalUserPercent: 1.95,
    superAgentPercent: 1.95,
    walletTopUpPercent: 1.95,
  });
  const { showError, showSuccess } = useNotification();
  // Role + ownership from `public.user_profiles`. See ProfileContext: the auth
  // record is not a trustworthy role source (`user_metadata` is self-writable,
  // `app_metadata` lives in the access token).
  const {
    isSuperAgent: isSuperAgentProfile,
    isSubAgent: isAgentProfile,
    superAgentId: profileSuperAgentId,
    profile,
  } = useProfile();
  const bundleSkeletonOpacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    let active = true;

    const loadSettings = async () => {
      try {
        const settings = await fetchPaymentChargeSettings();
        if (!active) return;
        setPaymentChargeSettings(settings);
      } catch (error) {
        console.warn(
          "Failed to load payment charge settings, using defaults:",
          error,
        );
      }
    };

    loadSettings();
    return () => {
      active = false;
    };
  }, []);

  const getAgentPaymentBreakdown = useCallback(() => {
    if (!selectedBundle || !selectedBundle.base_price) {
      return null;
    }

    const baseAmount = Number(selectedBundle.base_price || 0);
    const agentMarkup = Number(selectedBundle.tier_extra || 0);
    const chargePercent = superAgentId
      ? paymentChargeSettings.superAgentPercent
      : paymentChargeSettings.normalUserPercent;
    const transactionFee = getTransactionChargeAmount(
      baseAmount,
      chargePercent,
    );

    return {
      baseAmount,
      agentMarkup,
      transactionFee,
      grossAmount: Number(
        (baseAmount + agentMarkup + transactionFee).toFixed(2),
      ),
      mainAccountAmount: transactionFee,
    };
  }, [selectedBundle, superAgentId, paymentChargeSettings]);

  const dispatchProviderOrder = useCallback(async (orderId, orderType) => {
    const functionName = getEdgeFunctionName("dispatch-order");
    const { data, error } = await supabase.functions.invoke(functionName, {
      body: { order_id: orderId, order_type: orderType },
    });

    // A 2xx that reports `deferred: true` is a QUEUED order: the provider
    // could not be reached yet (usually an unfunded provider account) and the
    // admin will retry it. A 4xx is a PERMANENT failure - the order is missing
    // data it can never be dispatched with, so retrying will not help.
    //
    // These must not be collapsed into one another. Reporting a 4xx as
    // "queued, we'll complete the delivery shortly" is how an undeliverable
    // order ends up looking identical to a legitimately deferred one.
    const status = Number(error?.status || error?.context?.status || 0);
    const rejected = Boolean(error) && status >= 400 && status < 500;

    return {
      data,
      error,
      // The edge function reports a queued order as deferred rather than
      // failed, so the customer keeps a confirmed receipt.
      deferred: Boolean(!error && data?.deferred),
      dispatched: Boolean(!error && data?.success && !data?.deferred),
      // Undispatchable: needs a fix, not a retry. Surfaced so the caller can
      // tell the customer their order cannot be delivered.
      rejected,
      status,
      errorMessage:
        data?.error ||
        error?.context?.error ||
        error?.message ||
        "The provider could not accept this order.",
    };
  }, []);

  // Paystack payment handlers
  const handlePaymentSuccess = useCallback(
    async (response) => {
      setPaystackModalVisible(false);

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          showError("Authentication Error", "User not found");
          return;
        }

        const functionName = getEdgeFunctionName("verify-payment");
        const { data, error } = await supabase.functions.invoke(functionName, {
          body: {
            reference: response.reference,
            user_id: user.id,
            offer_id: selectedBundle.id,
            provider_package_id: selectedBundle.package_id || selectedBundle.id,
            package_name: selectedBundle.name,
            package_type: selectedBundle.type || null,
            package_size: selectedBundle.dataSize || null,
            provider_type: selectedBundle.type || null,
            provider_size: Number(
              String(selectedBundle.dataSize || "").match(/[\d.]+/)?.[0] || 0,
            ),
            amount:
              getAgentPaymentBreakdown()?.grossAmount ||
              parseFloat(selectedBundle.price.replace("Ghc ", "")),
            network: network,
            recipient_phone: isAgent
              ? recipientPhone.trim().replace(/\s+/g, "")
              : purchaseType === "self"
                ? userPhone
                : recipientPhone.trim().replace(/\s+/g, ""),
            super_agent_id: superAgentId,
            paystack_subaccount_code: resolvedSubaccountCode,
            base_price: getAgentPaymentBreakdown()?.baseAmount || 0,
            tier_extra: getAgentPaymentBreakdown()?.agentMarkup || 0,
            transaction_fee: getAgentPaymentBreakdown()?.transactionFee || 0,
          },
        });

        if (error) {
          console.error("[Purchase] Edge function failed:", {
            function: functionName,
            name: error.name,
            message: error.message,
            status: error.status,
            details: error.context || error.error || null,
          });

          // The wallet path returns 402 when the super agent cannot afford the
          // purchase. That is a specific, actionable condition - "top up your
          // wallet" - and lumping it in with "contact support if payment was
          // deducted" told the user to chase support for something only they
          // can fix. Read the real reason off `err.context` (a Response), which
          // is where supabase-js puts a non-2xx body; `err.error` / `err.data`
          // are empty here, so reading those loses the message.
          let serverPayload = null;
          const context = error.context;
          if (context && typeof context.clone === "function") {
            try {
              serverPayload = await context.clone().json();
            } catch {
              serverPayload = null;
            }
          }

          if (serverPayload?.insufficient_balance) {
            const shortfall = Number(serverPayload.shortfall || 0);
            // `formatCedi` is this screen's money formatter (see its definition
            // below); there is no `formatGhc` in this file.
            showError(
              "Insufficient Wallet Balance",
              `This purchase costs ${formatCedi(
                serverPayload.required || 0,
              )} but your wallet holds ${formatCedi(
                serverPayload.balance || 0,
              )}. Top up your wallet by ${formatCedi(shortfall)} to continue.`,
            );
            return;
          }

          showError(
            "Payment Verification Failed",
            serverPayload?.error ||
              "Please contact support if payment was deducted",
          );
          return;
        }

        if (data.success) {
          if (data.held) {
            showError(
              "Order Pending",
              "Payment received, but the Super Agent wallet needs funding before this order can be fulfilled.",
            );
            return;
          }

          const orderType = data.is_agent_order ? "agent" : "regular";
          const providerResult = await dispatchProviderOrder(
            data.order.id,
            orderType,
          );

          if (providerResult.rejected) {
            // Permanent failure, distinct from a queue state. Reporting this as
            // "confirmed and being processed" would leave the customer with a
            // paid order that can never be dispatched and no indication of it.
            showError(
              "Order Could Not Be Delivered",
              `Your payment went through, but this order could not be sent to the provider. ${providerResult.errorMessage} Contact support with reference ${data.order.payment_reference}.`,
            );
            return;
          }

          if (providerResult.deferred) {
            // The payment succeeded but the provider could not be reached
            // (usually the admin's provider account is out of funds). The
            // order is queued and the admin can send it once they top up, so
            // tell the customer it is being processed rather than showing a
            // failure they cannot act on.
            showSuccess(
              "Order Received",
              // The deferred reason comes from the DISPATCH response, not
              // from verify-payment. Reading it off `data` meant it was always
              // undefined, so every queued order claimed the balance message
              // regardless of the actual reason.
              providerResult.data?.reason === "insufficient_api_balance"
                ? "Your order is confirmed and is being processed. It will be delivered shortly."
                : "Your order is confirmed and is queued for delivery.",
            );
            navigation.navigate("Receipt", {
              transaction: {
                id: data.order.id,
                status: "pending",
                offer_title: selectedBundle.name,
                network: network,
                data_amount: selectedBundle.name,
                amount: data.order.amount,
                created_at: data.order.created_at,
                payment_reference: data.order.payment_reference,
                user_name:
                  user.user_metadata?.full_name ||
                  user.email?.split("@")[0] ||
                  "N/A",
                user_email: user.email,
                phone: isAgent
                  ? recipientPhone.trim().replace(/\s+/g, "")
                  : purchaseType === "self"
                    ? userPhone
                    : recipientPhone.trim().replace(/\s+/g, ""),
                country_code: "GH",
                orderType: "user",
              },
            });
            return;
          }

          if (!providerResult.dispatched) {
            showError(
              "Order Queued",
              "Your payment went through and the order is saved. Our team will complete the delivery shortly.",
            );
            return;
          }

          showSuccess(
            "Purchase Successful!",
            `Your ${selectedBundle.name} data bundle has been purchased successfully!`,
          );
          navigation.navigate("Receipt", {
            transaction: {
              id: data.order.id,
              status: "processing",
              offer_title: selectedBundle.name,
              network: network,
              data_amount: selectedBundle.name,
              amount: data.order.amount,
              created_at: data.order.created_at,
              payment_reference: data.order.payment_reference,
              user_name:
                user.user_metadata?.full_name ||
                user.email?.split("@")[0] ||
                "N/A",
              user_email: user.email,
              phone: isAgent
                ? recipientPhone.trim().replace(/\s+/g, "")
                : purchaseType === "self"
                  ? userPhone
                  : recipientPhone.trim().replace(/\s+/g, ""),
              country_code: "GH",
              orderType: "user",
            },
          });
        } else {
          showError(
            "Payment Failed",
            data.message || "Payment verification failed",
          );
        }
      } catch (error) {
        console.error("Payment verification error:", error);
        showError(
          "Payment Verification Failed",
          "Please contact support if payment was deducted",
        );
      }
    },
    [
      selectedBundle,
      isAgent,
      purchaseType,
      userPhone,
      recipientPhone,
      network,
      navigation,
      showError,
      showSuccess,
      dispatchProviderOrder,
      getAgentPaymentBreakdown,
    ],
  );

  const handlePaymentClose = useCallback(() => {
    setPaystackModalVisible(false);
    showError("Payment Cancelled", "Payment was cancelled by user");
  }, [showError]);

  const [paystackPublicKey, setPaystackPublicKey] = useState("");
  const [paystackKeyError, setPaystackKeyError] = useState(false);

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

  // Paystack configuration
  const paystackConfig = useMemo(() => {
    if (!selectedBundle || !userEmail) return null;

    const paymentBreakdown = getAgentPaymentBreakdown();
    const payableAmount = paymentBreakdown
      ? paymentBreakdown.grossAmount
      : parseFloat(selectedBundle.price.replace("Ghc ", ""));

    return {
      reference: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      email: userEmail,
      amount: Math.floor(payableAmount * 100),
      transactionCharge: paymentBreakdown
        ? Math.floor(paymentBreakdown.mainAccountAmount * 100)
        : null,
      currency: "GHS",
      publicKey: paystackPublicKey,
      subaccount: resolvedSubaccountCode || null,
      metadata: {
        offer_id: selectedBundle.id,
        offer_title: selectedBundle.name,
        network: network,
        is_self: purchaseType === "self",
        recipient_phone:
          purchaseType === "self"
            ? userPhone
            : recipientPhone.trim().replace(/\s+/g, ""),
        super_agent_id: superAgentId || null,
        paystack_subaccount_code: resolvedSubaccountCode || null,
        base_price: selectedBundle.base_price || 0,
        tier_price: payableAmount,
        transaction_fee: paymentBreakdown?.transactionFee || 0,
      },
      onSuccess: handlePaymentSuccess,
      onClose: handlePaymentClose,
    };
  }, [
    selectedBundle,
    userEmail,
    network,
    purchaseType,
    userPhone,
    recipientPhone,
    resolvedSubaccountCode,
    superAgentId,
    paystackPublicKey,
    handlePaymentSuccess,
    handlePaymentClose,
    getAgentPaymentBreakdown,
  ]);

  const { initializePayment, isLoaded, isLoading } =
    usePaystackPayment(paystackConfig);

  // Add loading state for Paystack initialization
  const [paystackLoading, setPaystackLoading] = useState(false);

  useEffect(() => {
    if (
      Platform.OS !== "web" ||
      !directPaystackRequested ||
      !selectedBundle ||
      !initializePayment ||
      !paystackPublicKey
    ) {
      return;
    }

    setDirectPaystackRequested(false);
    setPaystackLoading(true);
    Promise.resolve(initializePayment())
      .catch((error) => {
        console.error("Paystack initialization error:", error);
        showError("Payment Error", "Failed to open Paystack payment.");
      })
      .finally(() => setPaystackLoading(false));
  }, [
    directPaystackRequested,
    selectedBundle,
    paystackPublicKey,
    initializePayment,
    showError,
  ]);

  // Format network name for display (uppercase)
  const displayNetwork = network.toUpperCase();

  useEffect(() => {
    if (agentChecked) {
      fetchOffers();
    }
  }, [network, isAgent, agentChecked]);

  useEffect(() => {
    fetchUserEmail();
  }, [network]);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(bundleSkeletonOpacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(bundleSkeletonOpacity, {
          toValue: 0.6,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [bundleSkeletonOpacity]);

  const fetchUserEmail = async () => {
    try {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();
      if (user && user.email) {
        setUserEmail(user.email);
        setUserPhone(profile?.phone || user.user_metadata?.phone || "");

        // The owning Super Agent, from `public.user_profiles.super_agent_id`
        // via the profile context.
        //
        // This local was REMOVED during the profile refactor while the
        // `if (assignedSuperAgentId)` below still read it. That threw a
        // `ReferenceError`, which the `catch` at the end of this function
        // swallowed into `setAgentChecked(true)` - so nothing surfaced, the
        // sub-account block was simply skipped, and a sub-agent ended up buying
        // with the PLATFORM Paystack account instead of their Super Agent's
        // settlement subaccount.
        //
        // Lesson (twice now, see the `retainsWallet(userId, ...)` call):
        // removing a declaration means grepping for EVERY reference to it, not
        // just the block being edited - and note the failure here was worse
        // than a crash, because the catch turned it into missing behaviour.
        const assignedSuperAgentId = profileSuperAgentId || null;

        // Role and ownership come from `public.user_profiles` (the profile
        // context), NOT from auth metadata: `user_metadata.role` and
        // `user_metadata.super_agent_id` are both writable by the account owner
        // via `auth.updateUser()`, so they cannot decide who somebody is or
        // which Super Agent settles their purchase.
        //
        // `phone` and `tier_name` are the two exceptions and are NOT roles -
        // `user_profiles` has no such column, so they still come from metadata.
        // They are display/contact data, not authorization.
        setSuperAgentId(profileSuperAgentId || null);
        setAgentTier(
          user.user_metadata?.tier_name || user.app_metadata?.tier_name || null,
        );

        setIsSuperAgentUser(isSuperAgentProfile);
        // A sub-agent OR a super agent may buy from an agent package list, and
        // an ownerless sub-agent still gets the General list.
        const isUserRoleAgent = isAgentProfile || isSuperAgentProfile;

        setIsAgent(isUserRoleAgent);

        // If this user is a sub-agent of a super agent, fetch the exact
        // Paystack sub-account details used to settle the purchase.
        if (assignedSuperAgentId) {
          setSubaccountLoading(true);
          try {
            const { data: subaccountResponse, error: subaccountError } =
              await supabase.functions.invoke(
                getEdgeFunctionName("super-agent-user-management"),
                { body: { action: "getPaystackSubaccount" } },
              );
            const record = subaccountResponse?.subaccount || null;
            if (subaccountError || !record) {
              setPaystackSubaccount(null);
              setResolvedSubaccountCode(null);
            } else if (record?.is_active && record.subaccount_code) {
              setPaystackSubaccount(record);
              setResolvedSubaccountCode(record.subaccount_code);
            } else {
              setPaystackSubaccount(record);
              setResolvedSubaccountCode(null);
            }
          } catch (subaccountError) {
            setPaystackSubaccount(null);
            setResolvedSubaccountCode(null);
            console.warn(
              "Could not resolve Paystack subaccount for data purchase:",
              subaccountError,
            );
          } finally {
            setSubaccountLoading(false);
          }
        } else {
          setPaystackSubaccount(null);
          setResolvedSubaccountCode(null);
        }

        setAgentChecked(true);
      } else {
        // No user logged in, treat as regular user
        setIsAgent(false);
        setAgentChecked(true);
      }
    } catch (error) {
      console.error("Error fetching user email:", error);
      setIsAgent(false);
      setAgentChecked(true);
    }
  };

  const fetchOffers = async () => {
    try {
      setLoading(true);

      if (isAgent) {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          setBundles([]);
          setLoading(false);
          return;
        }

        // The owning Super Agent, from the profile. The old chain preferred
        // `user_metadata.super_agent_id`, which the account owner controls, and
        // would silently fall back to a locally-held id - so a user could point
        // their purchases at an arbitrary settlement account.
        const assignedSuperAgentId = profileSuperAgentId || null;

        // Sub-agents buy from the packages their super agent published for the
        // tier they were granted (falling back to the super agent's General prices).
        if (assignedSuperAgentId) {
          // The owner is passed in from the profile rather than re-read from
          // auth metadata inside the service - see the note there.
          const agentPackagesResult = await loadSubAgentPackages({
            user,
            network,
            superAgentId: assignedSuperAgentId,
          });

          if (
            agentPackagesResult.error &&
            (!agentPackagesResult.offers ||
              agentPackagesResult.offers.length === 0)
          ) {
            console.error(
              "Error fetching super agent packages:",
              agentPackagesResult.error,
            );
            showError("Error", "Failed to load your assigned data bundles");
            setBundles([]);
            setLoading(false);
            return;
          }

          setAgentTier(agentPackagesResult.agent_tier || null);

          const superAgentOffers = Array.isArray(agentPackagesResult.offers)
            ? agentPackagesResult.offers
            : [];

          if (superAgentOffers.length === 0) {
            setBundles([]);
            setLoading(false);
            return;
          }

          const mappedBundles = superAgentOffers
            .filter(
              (agentOffer) =>
                String(agentOffer.network || "").toUpperCase() ===
                network.toUpperCase(),
            )
            .map((agentOffer) => {
              const descriptor = String(agentOffer.data_value || "");

              return {
                id: String(agentOffer.superAgentOfferId || agentOffer.id),
                package_id: agentOffer.package_id || null,
                superAgentOfferId:
                  agentOffer.superAgentOfferId || agentOffer.id,
                network: String(agentOffer.network || "").toUpperCase(),
                type: String(agentOffer.type || descriptor).toUpperCase(),
                name:
                  agentOffer.title || `${agentOffer.network} — ${descriptor}`,
                price:
                  typeof agentOffer.price === "string" &&
                  agentOffer.price.startsWith("Ghc")
                    ? agentOffer.price
                    : `Ghc ${Number(agentOffer.price || 0).toFixed(2)}`,
                dataSize:
                  agentOffer.dataSize ||
                  (agentOffer.size
                    ? `${agentOffer.size} GB`
                    : formatBundleSizeFromDescriptor(descriptor)),
                base_price: Number(
                  agentOffer.base_price || agentOffer.price || 0,
                ),
                tier_extra: Number(agentOffer.tier_extra || 0),
                tierName: agentOffer.tier_name || null,
              };
            });

          setBundles(mappedBundles);
          setLoading(false);
          return;
        }

        // Direct top-level agent without a super agent: load from catalog
        const catalogOffers = await fetchCatalogPackages();
        const { data: pricingRows, error: pricingError } = await supabase
          .from("package_pricing")
          .select("package_id, network, type, size, base_price, is_active")
          .eq("is_active", true);

        if (pricingError) {
          console.warn("Could not load admin package pricing:", pricingError);
        }

        const basePriceByKey = {};
        const basePriceByPackageId = {};
        (pricingRows || []).forEach((row) => {
          const descriptor = String(row.type || "")
            .trim()
            .toUpperCase();
          const key = `${String(row.network || "").toUpperCase()}::${descriptor}`;
          basePriceByKey[key] = Number(row.base_price || 0);
          if (row.package_id) {
            basePriceByPackageId[String(row.package_id)] = Number(
              row.base_price || 0,
            );
          }
        });

        const filteredOffers = (catalogOffers || []).filter((pkg) => {
          if (pkg.network?.toUpperCase() !== network.toUpperCase()) {
            return false;
          }
          const pkgType = String(pkg.type || "")
            .trim()
            .toUpperCase();
          const pkgSize =
            pkg.size !== undefined && pkg.size !== null ? `${pkg.size}GB` : "";
          const pkgDescriptor =
            pkgSize && !pkgType.includes(pkgSize)
              ? `${pkgType} - ${pkgSize}`.toUpperCase()
              : (pkgType || pkgSize).toUpperCase();
          return (pricingRows || []).some((row) => {
            if (row.package_id && String(row.package_id) === String(pkg.id)) {
              return true;
            }
            const rowType = String(row.type || "")
              .trim()
              .toUpperCase();
            return (
              String(row.network || "").toUpperCase() ===
                String(pkg.network || "").toUpperCase() &&
              (rowType === pkgType || rowType === pkgDescriptor)
            );
          });
        });
        const mappedBundles = filteredOffers.map((pkg) => {
          const rawType = String(pkg.type || "").trim();
          const size =
            pkg.size !== undefined && pkg.size !== null ? `${pkg.size}GB` : "";
          const descriptor =
            size && !rawType.toUpperCase().includes(size.toUpperCase())
              ? `${rawType} - ${size}`.toUpperCase()
              : (rawType || size).toUpperCase();
          const key = `${String(pkg.network || "").toUpperCase()}::${descriptor}`;
          const basePrice =
            basePriceByPackageId[String(pkg.id)] ?? basePriceByKey[key];
          const catalogPrice = Number(pkg.price || 0) / 100;
          const finalPrice = basePrice > 0 ? basePrice : catalogPrice;

          return {
            id: pkg.id,
            package_id: pkg.id,
            network: pkg.network,
            type: pkg.type,
            name: `${pkg.network} — ${pkg.type}`,
            price: `Ghc ${finalPrice.toFixed(2)}`,
            base_price: finalPrice,
            dataSize: `${pkg.size} GB`,
          };
        });
        setBundles(mappedBundles);
        setLoading(false);
        return;
      }

      // Regular customer
      const { data: pricingRows, error: pricingError } = await supabase
        .from("normal_user_package_pricing")
        .select("package_id, network, type, size, base_price, is_active")
        .eq("is_active", true);

      if (pricingError) throw pricingError;

      const mappedBundles = (pricingRows || [])
        .filter(
          (row) =>
            String(row.network || "").toUpperCase() === network.toUpperCase(),
        )
        .map((row) => {
          const descriptor = String(row.type || "").trim();
          const size = row.size ?? null;
          const displayName = `${row.network} — ${descriptor}`;

          return {
            id: row.package_id || `${row.network}-${descriptor}`,
            package_id: row.package_id || null,
            network: String(row.network || "").toUpperCase(),
            type: descriptor,
            name: displayName,
            price: `Ghc ${Number(row.base_price || 0).toFixed(2)}`,
            base_price: Number(row.base_price || 0),
            dataSize:
              size !== null
                ? `${size} GB`
                : formatBundleSizeFromDescriptor(descriptor),
          };
        });
      setBundles(mappedBundles);
    } catch (error) {
      console.error("Error:", error);
      showError("Error", "Failed to load data bundles");
      setBundles([]);
    } finally {
      setLoading(false);
    }
  };

  // Groups bundles by network and sorts each group by ascending price.
  const groupBundlesByNetwork = useCallback((list) => {
    const grouped = {};
    list.forEach((bundle) => {
      const networkName = bundle.name.split(" — ")[0]?.trim() || "Other";
      if (!grouped[networkName]) {
        grouped[networkName] = [];
      }
      grouped[networkName].push(bundle);
    });

    Object.values(grouped).forEach((networkBundles) => {
      networkBundles.sort((first, second) => {
        const firstPrice = Number(
          first.base_price ??
            String(first.price || "").replace(/[^0-9.]/g, "") ??
            0,
        );
        const secondPrice = Number(
          second.base_price ??
            String(second.price || "").replace(/[^0-9.]/g, "") ??
            0,
        );
        return firstPrice - secondPrice;
      });
    });

    return grouped;
  }, []);

  // Provider family shown as a tab. The type strings are free-form
  // (e.g. "MTN 1GB - Daily"), so the family is inferred the same way the
  // provider API groups them: BIG TIME, ISHARE, everything else.
  const getBundleFamily = (bundle) => {
    const type = String(bundle?.type || "").toUpperCase();
    if (type.includes("BIG TIME")) return "big_time";
    if (type.includes("ISHARE")) return "ishare";
    return "everyday";
  };

  const bundleFamilies = useMemo(() => {
    const families = new Map();
    bundles.forEach((bundle) => {
      const family = getBundleFamily(bundle);
      const existing = families.get(family) || { key: family, count: 0 };
      existing.count += 1;
      families.set(family, existing);
    });

    // Stable, meaningful order rather than Map insertion order.
    return BUNDLE_FAMILY_ORDER.filter((family) => families.has(family.key)).map(
      (family) => families.get(family.key),
    );
  }, [bundles]);

  // A single family means there is nothing to switch between, so the tab strip
  // is hidden entirely rather than showing one pointless tab.
  const showFamilyTabs = bundleFamilies.length > 1;

  const activeFamilyKey = useMemo(() => {
    if (!showFamilyTabs) return null;
    const stillExists = bundleFamilies.some(
      (family) => family.key === activeFamily,
    );
    if (stillExists) return activeFamily;
    return bundleFamilies[0]?.key || null;
  }, [activeFamily, bundleFamilies, showFamilyTabs]);

  // Reset the active tab when the network changes so a family that does not
  // exist on the new network never shows an empty list.
  useEffect(() => {
    setActiveFamily(null);
  }, [network, isAgent]);

  const visibleBundles = useMemo(() => {
    if (!showFamilyTabs || !activeFamilyKey) return bundles;
    return bundles.filter(
      (bundle) => getBundleFamily(bundle) === activeFamilyKey,
    );
  }, [bundles, showFamilyTabs, activeFamilyKey]);

  const visibleBundlesByNetwork = useMemo(
    () => groupBundlesByNetwork(visibleBundles),
    [visibleBundles, groupBundlesByNetwork],
  );

  const handlePurchaseForSelf = async (bundle) => {
    try {
      // Get current user
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        showError("Authentication Error", "Please log in to make a purchase");
        return;
      }

      // Check if user has a phone number
      if (!userPhone.trim()) {
        showError(
          "Phone Number Required",
          "Please update your profile with a phone number to purchase for yourself",
        );
        return;
      }

      // Wallet purchases use the same base, markup, and 2% fee contract.
      const price = parseFloat(bundle.price.replace("Ghc ", ""));
      const basePrice = Number(bundle.base_price || price);
      const agentMarkup = Number(
        bundle.tier_extra ?? Math.max(0, price - basePrice),
      );
      const transactionFee = Number((basePrice * 0.02).toFixed(2));
      const grossPrice = Number(
        (basePrice + agentMarkup + transactionFee).toFixed(2),
      );

      if (isNaN(price)) {
        showError("Error", "Invalid bundle price");
        return;
      }

      // Open Paystack payment modal
      setSelectedBundle(bundle);
      if (Platform.OS === "web") {
        setDirectPaystackRequested(true);
      } else {
        setPaystackModalVisible(true);
      }
    } catch (error) {
      console.error("Purchase error:", error);
      showError("Error", "Failed to initiate purchase");
    }
  };

  const handlePurchaseForOthers = async (bundle) => {
    try {
      // Get current user
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        showError("Authentication Error", "Please log in to make a purchase");
        return;
      }

      // Validate recipient phone number
      if (!recipientPhone.trim()) {
        showError(
          "Phone Number Required",
          "Please enter the recipient's phone number",
        );
        return;
      }

      // The field is already sanitised, so this only has to catch an
      // incomplete or wrongly-prefixed number. `getGhanaPhoneError` names the
      // actual problem instead of one generic "invalid format" string, which
      // is what the previous single regex produced for every failure.
      const cleanPhone = recipientPhone.trim();
      const phoneError = getGhanaPhoneError(cleanPhone);
      if (phoneError) {
        showError("Invalid Phone Number", phoneError);
        return;
      }

      // Extract price as number (remove 'Ghc ' prefix)
      const price = parseFloat(bundle.price.replace("Ghc ", ""));

      if (isNaN(price)) {
        showError("Error", "Invalid bundle price");
        return;
      }

      // Open Paystack payment modal
      setSelectedBundle(bundle);
      if (Platform.OS === "web") {
        setDirectPaystackRequested(true);
      } else {
        setPaystackModalVisible(true);
      }
    } catch (error) {
      console.error("Purchase error:", error);
      showError("Error", "Failed to initiate purchase");
    }
  };

  const handleAgentPurchase = async (bundle) => {
    try {
      const price = parseFloat(bundle.price.replace("Ghc ", ""));
      if (isNaN(price)) {
        showError("Error", "Invalid bundle price");
        return;
      }

      setSelectedBundle(bundle);
      setRecipientModalVisible(true);
    } catch (error) {
      console.error("Agent package selection error:", error);
      showError("Error", "Failed to select package");
    }
  };

  const openNormalPurchase = (bundle) => {
    setSelectedBundle(bundle);
    setPurchaseType("self");
    setRecipientPhone("");
    setRecipientModalVisible(true);
  };

  const continueNormalPurchase = async () => {
    if (purchaseType === "self") {
      setRecipientModalVisible(false);
      await handlePurchaseForSelf(selectedBundle);
      return;
    }

    setRecipientModalVisible(false);
    await handlePurchaseForOthers(selectedBundle);
  };

  const openPaymentConfirmation = async () => {
    if (isAgent && !isSuperAgentUser) {
      setSubaccountLoading(true);
      try {
        const { data: subaccountResponse, error: subaccountError } =
          await supabase.functions.invoke(
            getEdgeFunctionName("super-agent-user-management"),
            { body: { action: "getPaystackSubaccount" } },
          );
        const record = subaccountResponse?.subaccount || null;
        if (subaccountError || subaccountResponse?.error || !record) {
          setPaystackSubaccount(null);
          setResolvedSubaccountCode(null);
          showError(
            "Payment Unavailable",
            "Could not fetch your Super Agent's Paystack settlement details. Please try again.",
          );
          return;
        }

        setPaystackSubaccount(record);
        if (!record.is_active || !record.subaccount_code) {
          setResolvedSubaccountCode(null);
          showError(
            "Payment Unavailable",
            "Your Super Agent's Paystack settlement account is not active. Please contact your Super Agent before paying.",
          );
          return;
        }

        setResolvedSubaccountCode(record.subaccount_code);
        // Keep the confirmation screen open for sub-agents on every platform
        // so the settlement destination is visible before Paystack opens.
        setPaystackModalVisible(true);
        return;
      } catch (error) {
        setPaystackSubaccount(null);
        setResolvedSubaccountCode(null);
        showError(
          "Payment Unavailable",
          "Could not fetch your Super Agent's Paystack settlement details. Please try again.",
        );
        return;
      } finally {
        setSubaccountLoading(false);
      }
    }

    if (Platform.OS === "web") {
      setDirectPaystackRequested(true);
    } else {
      setPaystackModalVisible(true);
    }
  };

  const handleSuperAgentWalletPurchase = async (bundle, phone) => {
    const baseAmount = Number(bundle.base_price || 0);
    // WHY THERE IS NO TRANSACTION FEE HERE
    // -----------------------------------
    // The 1.95% Paystack charge is applied at TOP-UP time, not per order, and
    // the wallet is credited the NET figure: top up Ghc 100 and the user pays
    // 101.95 to Paystack but the wallet receives 100 (see
    // `verify-wallet-topup`, which credits `wallet_topups.amount` - the net).
    //
    // Charging it again per order was a genuine double-charge. A super agent
    // who topped up 100 and bought two Ghc 50 packages was debited
    // 50.98 + 50.98 = 101.96 for 100 of data, on top of the 1.95 they had
    // already paid at the till. Over a lot of orders that silently ate the
    // entire margin the tier pricing was built to give them.
    //
    // The wallet therefore debits the PACKAGE PRICE and nothing else.
    // `transaction_fee` is sent as 0, not omitted: the server treats a missing
    // fee as "not configured" and falls back to its own split calculation.
    const transactionFee = 0;
    const grossAmount = Number(baseAmount.toFixed(2));
    const reference = `wallet_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const functionName = getEdgeFunctionName("verify-payment");

    try {
      const { data, error } = await supabase.functions.invoke(functionName, {
        body: {
          wallet_order: true,
          reference,
          offer_id: bundle.id,
          package_name: bundle.name,
          package_size: bundle.dataSize || null,
          // Provider identity. Without these the order cannot be dispatched:
          // `dispatch-order` rejects any order missing a package id, size or
          // type BEFORE it ever contacts the provider, so the wallet would be
          // debited for an order that can never be delivered. Mirrors the
          // Paystack path above.
          provider_package_id: bundle.package_id || bundle.id,
          package_type: bundle.type || null,
          provider_type: bundle.type || null,
          provider_size: Number(
            String(bundle.dataSize || "").match(/[\d.]+/)?.[0] || 0,
          ),
          recipient_phone: phone,
          amount: grossAmount,
          network,
          base_price: baseAmount,
          transaction_fee: transactionFee,
        },
      });

      if (error || !data?.success) {
        console.error("[Purchase] Wallet edge function failed:", {
          function: functionName,
          message: error?.message || data?.error,
          details: error?.context || data?.details || null,
        });
        showError(
          "Wallet Purchase Failed",
          data?.reason === "insufficient_balance"
            ? "Your Super Agent wallet balance is insufficient."
            : data?.error || "Could not debit the Super Agent wallet.",
        );
        return;
      }

      if (data.held) {
        showError(
          "Insufficient Wallet Balance",
          "Your Super Agent wallet does not have enough balance for this package.",
        );
        return;
      }

      const providerResult = await dispatchProviderOrder(
        data.order.id,
        "regular",
      );

      if (providerResult.rejected) {
        // The wallet was debited but the order cannot be dispatched - it is
        // missing data no retry can supply. Say so instead of implying the
        // data is on its way, so the customer does not silently lose the money.
        showError(
          "Order Could Not Be Delivered",
          `Your wallet was debited, but this order could not be sent to the provider. ${providerResult.errorMessage} Contact support with reference ${data.order.payment_reference}.`,
        );
        return;
      }

      if (!providerResult.dispatched) {
        // The wallet was already debited, so the order is recorded either way.
        // A deferred dispatch means the provider could not be reached yet and
        // the admin will retry it.
        showSuccess(
          providerResult.deferred ? "Order Queued" : "Purchase Saved",
          providerResult.deferred
            ? "Your wallet was debited and the order is queued for delivery."
            : "Your wallet was debited and the order was saved. Our team will complete the delivery shortly.",
        );
      } else {
        showSuccess(
          "Purchase Successful!",
          `${bundle.name} was purchased from your wallet.`,
        );
      }

      navigation.navigate("Receipt", {
        transaction: {
          id: data.order.id,
          status: providerResult.dispatched ? "processing" : "pending",
          offer_title: data.order.offer_title,
          network,
          data_amount: data.order.data_amount,
          amount: data.order.amount,
          created_at: data.order.created_at,
          payment_reference: data.order.payment_reference,
          user_email: userEmail,
          phone,
          country_code: "GH",
          orderType: "user",
        },
      });
    } catch (error) {
      console.error("[Purchase] Wallet purchase error:", error);
      showError("Wallet Purchase Failed", "Please try again.");
    }
  };

  // Mirrors the amounts `handleSuperAgentWalletPurchase` sends to the edge
  // function, so the confirmation shows exactly what will be debited.
  //
  // No transaction fee: the 1.95% is charged at top-up time and the wallet is
  // credited net, so re-charging it here would take it twice from the same
  // money. See `handleSuperAgentWalletPurchase`.
  const getWalletPurchaseBreakdown = useCallback(
    (bundle) => {
      const baseAmount = Number(bundle?.base_price || 0);
      const transactionFee = 0;
      return {
        baseAmount,
        transactionFee,
        grossAmount: Number((baseAmount + transactionFee).toFixed(2)),
      };
    },
    [paymentChargeSettings],
  );

  const formatCedi = (amount) => `GHS ${Number(amount || 0).toFixed(2)}`;

  const openWalletConfirmation = (bundle, phone) => {
    const breakdown = getWalletPurchaseBreakdown(bundle);
    if (breakdown.grossAmount <= 0) {
      showError("Purchase Unavailable", "This package has no valid price.");
      return;
    }

    setWalletConfirm({
      bundle,
      phone,
      breakdown,
      // Read live rather than trusting a cached value: the dialog quotes the
      // post-debit balance, and the server is the authority on whether the
      // order clears. `null` means "not loaded yet".
      agentBalance: null,
    });

    // The balance is a nice-to-have in the dialog, not a gate - the edge
    // function re-checks it authoritatively, so a failure here must not block
    // the agent from confirming.
    (async () => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const userId = auth?.user?.id;
        if (!userId) return;
        const { data, error } = await supabase
          .from("super_agent_wallets")
          .select("balance")
          .eq("super_agent_id", userId)
          .maybeSingle();
        if (error) return;
        setAgentBalance(Number(data?.balance || 0));
        setWalletConfirm((prev) =>
          prev ? { ...prev, agentBalance: Number(data?.balance || 0) } : prev,
        );
      } catch (balanceError) {
        console.warn(
          "Could not read wallet balance for confirmation:",
          balanceError,
        );
      }
    })();
  };

  const confirmWalletPurchase = async () => {
    if (!walletConfirm) return;
    setWalletPurchasing(true);
    const { bundle, phone } = walletConfirm;
    try {
      await handleSuperAgentWalletPurchase(bundle, phone);
    } finally {
      setWalletPurchasing(false);
      setWalletConfirm(null);
    }
  };

  const continueAgentPurchase = async () => {
    if (!recipientPhone.trim()) {
      showError(
        "Phone Number Required",
        "Please enter the recipient's phone number",
      );
      return;
    }

    const cleanPhone = recipientPhone.trim();
    const phoneError = getGhanaPhoneError(cleanPhone);
    if (phoneError) {
      showError("Invalid Phone Number", phoneError);
      return;
    }

    setRecipientModalVisible(false);
    if (isSuperAgentUser) {
      // Money leaves the wallet the moment the edge function runs, so confirm
      // the amount, recipient and resulting balance with the agent first.
      openWalletConfirmation(selectedBundle, cleanPhone);
      return;
    }

    await openPaymentConfirmation();
  };

  const generatePaystackHTML = (
    amount,
    email,
    reference,
    subaccountCode,
    transactionCharge,
    paystackPublicKey,
    settlementBusinessName,
    settlementBank,
    baseAmount,
    agentMarkup,
    transactionFee,
    showPackagePrice,
    packagePrice,
  ) => {
    const safeKey = paystackPublicKey
      ? String(paystackPublicKey).replace(/\\/g, "\\\\").replace(/'/g, "\\'")
      : "";
    const safeEmail = String(email || "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
    const safeRef = String(reference || "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
    const safeSub = subaccountCode
      ? String(subaccountCode).replace(/\\/g, "\\\\").replace(/'/g, "\\'")
      : "";
    const safeBusinessName = String(settlementBusinessName || "Super Agent")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
    const safeBank = String(settlementBank || "Paystack settlement account")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Paystack Payment</title>
        <script src="https://js.paystack.co/v1/inline.js"></script>
        <style>
          :root {
            --primary: #006769;
            --secondary: #2B5F1F;
            --accent: #40A578;
            --light: #f7f9fa;
          }
          body {
            margin: 0;
            padding: 0 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: white;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
          }
          .container {
            background: white;
            border-radius: 24px;
            padding: 40px 30px;
            width: 100%;
            max-width: 380px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
            text-align: center;
            transform: translateY(0);
            transition: all 0.3s ease;
          }
          .icon-container {
            width: 70px;
            height: 70px;
            background-color: #e6f7f7;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
          }
          .icon {
            font-size: 32px;
            color: var(--primary);
          }
          .title {
            font-size: 22px;
            font-weight: 800;
            color: #1A1A1A;
            margin-bottom: 12px;
          }
          .subtitle {
            font-size: 14px;
            color: #666;
            margin-bottom: 30px;
            line-height: 1.5;
          }
          .amount-container {
            background-color: var(--light);
            padding: 18px;
            border-radius: 16px;
            margin-bottom: 20px;
            border: 1px solid #eee;
          }
          .amount-label {
            font-size: 13px;
            font-weight: 600;
            color: var(--primary);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
          }
          .amount {
            font-size: 30px;
            font-weight: 900;
            color: #1A1A1A;
            margin-bottom: 14px;
          }
          .breakdown-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 7px 0;
            border-top: 1px solid #e5e9eb;
            font-size: 13px;
          }
          .breakdown-label { color: #667; }
          .breakdown-value { color: #1A1A1A; font-weight: 700; }
          .breakdown-total {
            border-top: 1px solid #cfd8dc;
            margin-top: 3px;
            padding-top: 10px;
            font-weight: 800;
          }
          .settlement-card {
            background: #f0faf5;
            border: 1px solid #b9e5ce;
            border-radius: 14px;
            padding: 14px;
            margin: -20px 0 30px;
            text-align: left;
          }
          .settlement-label {
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            color: #2B5F1F;
            margin-bottom: 6px;
          }
          .settlement-business {
            font-size: 14px;
            font-weight: 700;
            color: #1A1A1A;
            margin-bottom: 2px;
          }
          .settlement-bank,
          .settlement-account {
            font-size: 12px;
            color: #48604a;
            margin-top: 2px;
          }
          .pay-button {
            width: 100%;
            padding: 18px;
            background: linear-gradient(to right, var(--primary), var(--accent));
            color: white;
            border: none;
            border-radius: 16px;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 8px 20px rgba(0, 103, 105, 0.3);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
          }
          .pay-button:active {
            transform: scale(0.98);
            box-shadow: 0 4px 10px rgba(0, 103, 105, 0.2);
          }
          .cancel-button {
            margin-top: 20px;
            padding: 10px 20px;
            color: #888;
            background: none;
            border: none;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: color 0.2s ease;
          }
          .cancel-button:hover {
            color: var(--danger, #e74c3c);
          }
          .secure-note {
            margin-top: 30px;
            font-size: 11px;
            color: #aaa;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .secure-note span {
            margin-right: 5px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon-container">
            <span class="icon">🔒</span>
          </div>
          <h2 class="title">Secure Payment</h2>
          <p class="subtitle">You are about to complete your data bundle purchase. Your payment is secured and encrypted.</p>
          
          <div class="amount-container">
            <div class="amount-label">Payable Amount</div>
            <div class="amount">GHS ${amount.toFixed(2)}</div>
            <div class="breakdown-row">
              <span class="breakdown-label">${showPackagePrice ? "Package price" : "Base data price"}</span>
              <span class="breakdown-value">GHS ${Number(showPackagePrice ? packagePrice : baseAmount || 0).toFixed(2)}</span>
            </div>
            <div class="breakdown-row">
              <span class="breakdown-label">Transaction fee</span>
              <span class="breakdown-value">GHS ${Number(transactionFee || 0).toFixed(2)}</span>
            </div>
            <div class="breakdown-row breakdown-total">
              <span class="breakdown-label">Total payment</span>
              <span class="breakdown-value">GHS ${amount.toFixed(2)}</span>
            </div>
          </div>

          ${
            subaccountCode
              ? `
          <div class="settlement-card">
            <div class="settlement-label">Payment will be sent to</div>
            <div class="settlement-business">${safeBusinessName}</div>
            <div class="settlement-bank">${safeBank}</div>
          </div>`
              : ""
          }
          
          <button id="paystack-button" class="pay-button">
            Pay with Paystack
          </button>
          
          <button onclick="window.ReactNativeWebView.postMessage(JSON.stringify({type: 'cancel'}))" class="cancel-button">
            Cancel Transaction
          </button>
          
          <div class="secure-note">
            <span>🛡️</span> Secure Transaction by Paystack
          </div>
        </div>
 
        <script>
          document.getElementById('paystack-button').onclick = function() {
            var setupOptions = {
              key: '${safeKey}',
              email: '${safeEmail}',
              amount: ${amount * 100},
              currency: 'GHS',
              ref: '${safeRef}',
              callback: function(response) {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'success',
                  data: response
                }));
              },
              onClose: function() {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'cancel'
                }));
              }
            };
            ${safeSub ? "setupOptions.subaccount = '" + safeSub + "';" : ""}
            ${safeSub && transactionCharge ? `setupOptions.transaction_charge = ${transactionCharge};` : ""}
            var handler = PaystackPop.setup(setupOptions);
            handler.openIframe();
          };
        </script>
      </body>
      </html>
    `;
  };

  const getNetworkColor = (networkName) => {
    // Brand tokens from theme.js rather than inline hexes, so the network
    // badge matches the same colours the home-screen network cards use.
    switch (networkName) {
      case "MTN":
        return networks.mtn;
      case "TELECEL":
        return networks.telecel;
      case "AIRTELTIGO":
        return networks.airteltigo;
      default:
        return c.mintDim;
    }
  };

  const getNetworkImage = (networkName) => {
    switch (networkName) {
      case "MTN":
        return require("../../assets/mtn.jpg");
      case "TELECEL":
        return require("../../assets/telecel.jpg");
      case "AIRTELTIGO":
        return require("../../assets/airteltigo.jpg");
      default:
        return null;
    }
  };

  // The hero photo is painted under an 88%-opaque near-black scrim (`adScrim`),
  // which is deliberately dark in BOTH schemes. The hero text therefore must not
  // follow the scheme: in light mode `c.textPrimary` is near-black, and rendered
  // on that scrim it was effectively invisible. Text is light whenever the
  // scrim is present, falling back to the scheme colours only for the
  // no-image variant, which has no scrim and a plain `c.surface` behind it.
  const heroImage = getNetworkImage(displayNetwork);
  const heroText = heroImage ? c.heroText : c.textPrimary;
  const heroTextDim = heroImage ? c.heroTextDim : c.textMuted;
  // `mintDim` is mid-tone and fails against the scrim in light mode; the hero
  // count needs a fixed bright mint that reads on near-black in both schemes.
  const heroAccent = heroImage ? "#5CF0C8" : c.mintDim;

  const renderBundlePlaceholders = () => (
    <View style={s.bundleList}>
      {[0, 1, 2, 3, 4].map((index) => (
        <Animated.View
          key={`bundle-placeholder-${index}`}
          style={[s.bundleCard, { opacity: bundleSkeletonOpacity }]}
        >
          <View style={s.skeletonBody}>
            <View style={s.skeletonLine} />
            <View style={s.skeletonLineShort} />
          </View>
          <View style={s.skeletonPrice} />
        </Animated.View>
      ))}
    </View>
  );

  return (
    <View style={s.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      <ScrollView
        contentContainerStyle={[
          s.scrollContent,
          { paddingTop: topInset, paddingBottom: dockPadding },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Network header. The photo sits under a dark scrim (ad imagery and
            carrier art have no guaranteed brightness), and the badge initial
            uses the carrier brand token. */}
        <View style={s.hero}>
          {heroImage ? (
            <ImageBackground
              source={heroImage}
              style={s.heroImage}
              resizeMode="cover"
            >
              <View style={s.heroScrim} />
            </ImageBackground>
          ) : null}
          <View style={s.heroContent}>
            <View style={s.heroTop}>
              <View
                style={[
                  s.networkBadgeLarge,
                  { backgroundColor: getNetworkColor(displayNetwork) },
                ]}
              >
                <Text style={s.networkInitialLarge}>
                  {displayNetwork.charAt(0)}
                </Text>
              </View>
              <View style={s.heroHeadText}>
                <Text style={[s.heroTitle, { color: heroText }]}>
                  {displayNetwork}
                </Text>
                <Text style={[s.heroSubtitle, { color: heroTextDim }]}>
                  Choose your preferred data bundle
                </Text>
              </View>
            </View>
            <Text style={[s.heroCount, { color: heroAccent }]}>
              {loading || !agentChecked
                ? "Loading packages…"
                : `${visibleBundles.length} package${
                    visibleBundles.length === 1 ? "" : "s"
                  } available`}
            </Text>
          </View>
        </View>

        {/* Super agent package source - shown to sub-agents only */}
        {isAgent ? (
          <View style={s.tierBanner}>
            <Ionicons name="pricetags" size={16} color={c.mintDim} />
            <Text style={s.tierBannerText}>
              {agentTier
                ? `${agentTier} tier · prices set by your super agent`
                : "Packages and prices set by your super agent"}
            </Text>
          </View>
        ) : null}

        {showFamilyTabs ? (
          <View style={s.familyTabsWrap}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.familyTabsContent}
            >
              {bundleFamilies.map((family) => {
                const meta =
                  BUNDLE_FAMILY_ORDER.find(
                    (entry) => entry.key === family.key,
                  ) || BUNDLE_FAMILY_ORDER[0];
                const isActive = family.key === activeFamilyKey;
                return (
                  <TouchableOpacity
                    key={family.key}
                    style={[s.familyTab, isActive ? s.familyTabActive : null]}
                    onPress={() => setActiveFamily(family.key)}
                    activeOpacity={0.85}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: isActive }}
                    accessibilityLabel={`${meta.label} data, ${family.count} packages`}
                  >
                    <Ionicons
                      name={meta.icon}
                      size={13}
                      color={isActive ? c.onAccent : c.textMuted}
                    />
                    <Text
                      style={[
                        s.familyTabText,
                        isActive ? s.familyTabTextActive : null,
                      ]}
                    >
                      {meta.label}
                    </Text>
                    <View
                      style={[
                        s.familyTabCount,
                        isActive ? s.familyTabCountActive : null,
                      ]}
                    >
                      <Text
                        style={[
                          s.familyTabCountText,
                          isActive ? s.familyTabCountTextActive : null,
                        ]}
                      >
                        {family.count}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {loading || !agentChecked ? (
          renderBundlePlaceholders()
        ) : visibleBundles.length === 0 ? (
          <EmptyState
            icon="wifi-outline"
            title="No data bundles"
            message={
              bundles.length > 0
                ? "No packages in this data type. Try another tab."
                : isAgent
                  ? "Your super agent has not published packages for this network in your tier yet."
                  : `No data bundles available for ${displayNetwork} at the moment.`
            }
          />
        ) : (
          <View style={s.bundleList}>
            {Object.entries(visibleBundlesByNetwork).map(
              ([networkName, networkBundles]) => (
                <View key={networkName} style={s.group}>
                  {networkBundles.map((bundle) => (
                    <TouchableOpacity
                      key={bundle.id}
                      style={s.bundleCard}
                      activeOpacity={0.85}
                      onPress={() => {
                        if (isAgent) {
                          handleAgentPurchase(bundle);
                        } else {
                          openNormalPurchase(bundle);
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${bundle.name}, ${bundle.price}`}
                    >
                      <View style={s.bundleBody}>
                        <View style={s.bundleHead}>
                          <View
                            style={[
                              s.networkBadge,
                              {
                                backgroundColor: `${getNetworkColor(
                                  displayNetwork,
                                )}26`,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                s.networkBadgeText,
                                { color: getNetworkColor(displayNetwork) },
                              ]}
                            >
                              {bundle.network}
                            </Text>
                          </View>
                          <Text style={s.bundleType} numberOfLines={1}>
                            {bundle.type}
                          </Text>
                        </View>

                        <View style={s.bundleMeta}>
                          <View style={s.metaItem}>
                            <Text style={s.metaLabel}>Data</Text>
                            <Text style={s.metaValue}>{bundle.dataSize}</Text>
                          </View>
                          <View style={s.metaDivider} />
                          <View style={s.metaItem}>
                            <Text style={s.metaLabel}>Price</Text>
                            <Text style={s.metaValueStrong}>
                              {bundle.price}
                            </Text>
                          </View>
                        </View>
                      </View>

                      <Ionicons
                        name="chevron-forward"
                        size={16}
                        color={c.textMuted}
                        style={s.bundleChevron}
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              ),
            )}
          </View>
        )}

        <View style={s.infoCard}>
          <View style={s.infoHead}>
            <Ionicons
              name="information-circle-outline"
              size={16}
              color={c.mintDim}
            />
            <Text style={s.infoTitle}>Good to know</Text>
          </View>
          <View style={s.infoList}>
            {[
              "Data bundles activate automatically on purchase",
              "Validity starts from the moment of activation",
              "Unused data expires at the end of the validity period",
              "All prices include applicable taxes",
            ].map((line) => (
              <View key={line} style={s.infoRow}>
                <View style={s.infoBullet} />
                <Text style={s.infoText}>{line}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      {!isAgent && selectedBundle && recipientModalVisible && (
        <Modal
          visible={recipientModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setRecipientModalVisible(false)}
        >
          <View style={s.recipientModalOverlay}>
            <KeyboardAvoidingView
              style={s.recipientModalAvoidingView}
              behavior="padding"
            >
              <View style={s.recipientModalCard}>
                <View style={s.recipientModalContent}>
                  <View style={s.recipientModalHeader}>
                    <View>
                      <Text style={s.recipientModalTitle}>
                        Who is this data for?
                      </Text>
                      <Text style={s.recipientModalSubtitle}>
                        {selectedBundle.name}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => setRecipientModalVisible(false)}
                      style={s.recipientModalClose}
                    >
                      <Ionicons name="close" size={22} color={c.textMuted} />
                    </TouchableOpacity>
                  </View>

                  <View style={s.purchaseTypeButtons}>
                    <TouchableOpacity
                      style={[
                        s.purchaseTypeButton,
                        purchaseType === "self" && s.purchaseTypeButtonActive,
                      ]}
                      onPress={() => setPurchaseType("self")}
                    >
                      <Ionicons
                        name="person"
                        size={18}
                        color={
                          purchaseType === "self" ? c.onAccent : c.textSecondary
                        }
                      />
                      <Text
                        style={[
                          s.purchaseTypeButtonText,
                          purchaseType === "self" &&
                            s.purchaseTypeButtonTextActive,
                        ]}
                      >
                        For Myself
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        s.purchaseTypeButton,
                        purchaseType === "others" && s.purchaseTypeButtonActive,
                      ]}
                      onPress={() => setPurchaseType("others")}
                    >
                      <Ionicons
                        name="people"
                        size={18}
                        color={
                          purchaseType === "others"
                            ? c.onAccent
                            : c.textSecondary
                        }
                      />
                      <Text
                        style={[
                          s.purchaseTypeButtonText,
                          purchaseType === "others" &&
                            s.purchaseTypeButtonTextActive,
                        ]}
                      >
                        For Others
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {purchaseType === "self" && (
                    <View style={s.userPhoneContainer}>
                      <Ionicons
                        name="phone-portrait"
                        size={20}
                        color={c.mintDim}
                      />
                      <Text style={s.userPhoneText}>
                        Data will be sent to:{" "}
                        {userPhone || "your profile phone"}
                      </Text>
                    </View>
                  )}

                  {purchaseType === "others" && (
                    <>
                      <Text style={s.phoneInputLabel}>
                        Recipient Phone Number
                      </Text>
                      <View style={s.phoneInputWrapper}>
                        <Ionicons
                          name="call"
                          size={20}
                          color={c.textMuted}
                          style={s.phoneIcon}
                        />
                        <TextInput
                          style={s.phoneInput}
                          placeholder="Enter phone number (e.g., 0532973455)"
                          placeholderTextColor={c.textMuted}
                          value={recipientPhone}
                          onChangeText={handleRecipientPhoneChange}
                          keyboardType="phone-pad"
                          maxLength={10}
                        />
                      </View>
                    </>
                  )}

                  <TouchableOpacity
                    style={s.recipientContinueButton}
                    onPress={continueNormalPurchase}
                  >
                    <Text style={s.recipientContinueText}>
                      Continue to Payment
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        </Modal>
      )}

      {isAgent && selectedBundle && recipientModalVisible && (
        <Modal
          visible={recipientModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setRecipientModalVisible(false)}
        >
          <View style={s.recipientModalOverlay}>
            <KeyboardAvoidingView
              style={s.recipientModalAvoidingView}
              behavior="padding"
            >
              <View style={s.recipientModalCard}>
                <View style={s.recipientModalContent}>
                  <View style={s.recipientModalHeader}>
                    <View>
                      <Text style={s.recipientModalTitle}>
                        Recipient Details
                      </Text>
                      <Text style={s.recipientModalSubtitle}>
                        {selectedBundle.name}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => setRecipientModalVisible(false)}
                      style={s.recipientModalClose}
                    >
                      <Ionicons name="close" size={22} color={c.textMuted} />
                    </TouchableOpacity>
                  </View>

                  <Text style={s.phoneInputLabel}>Phone Number</Text>
                  <View style={s.phoneInputWrapper}>
                    <Ionicons
                      name="call"
                      size={20}
                      color={c.textMuted}
                      style={s.phoneIcon}
                    />
                    <TextInput
                      style={s.phoneInput}
                      placeholder="Enter phone number (e.g., 0532973455)"
                      placeholderTextColor={c.textMuted}
                      value={recipientPhone}
                      onChangeText={handleRecipientPhoneChange}
                      keyboardType="phone-pad"
                      maxLength={10}
                      autoFocus
                    />
                  </View>

                  <TouchableOpacity
                    style={s.recipientContinueButton}
                    onPress={continueAgentPurchase}
                  >
                    <Text style={s.recipientContinueText}>
                      {isSuperAgentUser
                        ? "Review Order"
                        : "Continue to Payment"}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        </Modal>
      )}

      {walletConfirm ? (
        <ConfirmDialog
          visible={Boolean(walletConfirm)}
          icon="wallet"
          title="Confirm Wallet Purchase"
          message={`Buy ${walletConfirm.bundle?.name} from your Super Agent wallet for ${walletConfirm.phone}? This is debited from your wallet balance immediately and cannot be undone.`}
          warning={
            walletConfirm.agentBalance != null &&
            walletConfirm.breakdown.grossAmount > walletConfirm.agentBalance
              ? `Your wallet balance of ${formatCedi(walletConfirm.agentBalance)} is less than this order. The order will be rejected until the wallet is funded.`
              : undefined
          }
          rows={[
            { label: "Package", value: walletConfirm.bundle?.name || "-" },
            { label: "Recipient", value: walletConfirm.phone },
            {
              label: "Package price",
              value: formatCedi(walletConfirm.breakdown.baseAmount),
            },
            // The 1.95% Paystack charge is paid at top-up, not here, so no fee
            // row: showing a 0.00 "Transaction fee" would imply a charge that
            // does not exist and hide where the money actually went.
            {
              label: "Total from wallet",
              value: formatCedi(walletConfirm.breakdown.grossAmount),
              emphasis: true,
            },
            ...(walletConfirm.agentBalance != null
              ? [
                  {
                    label: "Balance after",
                    value: formatCedi(
                      walletConfirm.agentBalance -
                        walletConfirm.breakdown.grossAmount,
                    ),
                  },
                ]
              : []),
          ]}
          confirmText="Pay Now"
          cancelText="Cancel"
          confirming={walletPurchasing}
          onCancel={() => {
            if (walletPurchasing) return;
            setWalletConfirm(null);
          }}
          onConfirm={confirmWalletPurchase}
        />
      ) : null}

      {selectedBundle && paystackModalVisible && (
        <Modal visible={paystackModalVisible} animationType="slide">
          {Platform.OS === "web" ? (
            // Web implementation using Paystack inline SDK
            <View
              style={{
                flex: 1,
                backgroundColor: "rgba(0, 0, 0, 0.5)",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <View
                style={{
                  backgroundColor: "white",
                  borderRadius: 20,
                  padding: 30,
                  width: "90%",
                  maxWidth: 400,
                  alignItems: "center",
                  shadowColor: "#000",
                  shadowOffset: { width: 0, height: 10 },
                  shadowOpacity: 0.25,
                  shadowRadius: 10,
                  elevation: 10,
                }}
              >
                {/* Header with icon */}
                <View style={{ alignItems: "center", marginBottom: 20 }}>
                  <View
                    style={{
                      width: 60,
                      height: 60,
                      borderRadius: 30,
                      backgroundColor: c.surfaceSunken,
                      justifyContent: "center",
                      alignItems: "center",
                      marginBottom: 15,
                    }}
                  >
                    <Ionicons name="card" size={30} color={c.mint} />
                  </View>
                  <Text
                    style={{
                      fontSize: 24,
                      fontWeight: "bold",
                      color: c.textPrimary,
                      textAlign: "center",
                    }}
                  >
                    Complete Your Payment
                  </Text>
                </View>
                {/* Amount display */}
                <View
                  style={{
                    backgroundColor: c.surfaceSunken,
                    paddingHorizontal: 16,
                    paddingVertical: 15,
                    borderRadius: 12,
                    marginBottom: isAgent && !isSuperAgentUser ? 14 : 30,
                    width: "100%",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      color: c.textMuted,
                      marginBottom: 4,
                      textAlign: "center",
                      fontWeight: "600",
                    }}
                  >
                    Amount to Pay
                  </Text>
                  <Text
                    style={{
                      fontSize: 27,
                      fontWeight: "bold",
                      color: c.mint,
                      textAlign: "center",
                      marginBottom: 12,
                    }}
                  >
                    GHS{" "}
                    {(
                      getAgentPaymentBreakdown()?.grossAmount ||
                      parseFloat(selectedBundle.price.replace("Ghc ", ""))
                    ).toFixed(2)}
                  </Text>
                  <View style={s.paymentBreakdownRow}>
                    <Text style={s.paymentBreakdownLabel}>
                      {isAgent && !isSuperAgentUser
                        ? "Package price"
                        : "Base data price"}
                    </Text>
                    <Text style={s.paymentBreakdownValue}>
                      GHS{" "}
                      {isAgent && !isSuperAgentUser
                        ? (
                            (getAgentPaymentBreakdown()?.baseAmount || 0) +
                            (getAgentPaymentBreakdown()?.agentMarkup || 0)
                          ).toFixed(2)
                        : (
                            getAgentPaymentBreakdown()?.baseAmount ||
                            parseFloat(selectedBundle.price.replace("Ghc ", ""))
                          ).toFixed(2)}
                    </Text>
                  </View>
                  <View style={s.paymentBreakdownRow}>
                    <Text style={s.paymentBreakdownLabel}>Transaction fee</Text>
                    <Text style={s.paymentBreakdownFee}>
                      GHS{" "}
                      {(
                        getAgentPaymentBreakdown()?.transactionFee || 0
                      ).toFixed(2)}
                    </Text>
                  </View>
                  <View
                    style={[s.paymentBreakdownRow, s.paymentBreakdownTotal]}
                  >
                    <Text style={s.paymentBreakdownTotalLabel}>
                      Total payment
                    </Text>
                    <Text style={s.paymentBreakdownTotalValue}>
                      GHS{" "}
                      {(
                        getAgentPaymentBreakdown()?.grossAmount ||
                        parseFloat(selectedBundle.price.replace("Ghc ", ""))
                      ).toFixed(2)}
                    </Text>
                  </View>
                </View>
                {isAgent && !isSuperAgentUser && (
                  <View
                    style={{
                      alignSelf: "stretch",
                      backgroundColor: `${c.mint}12`,
                      borderColor: `${c.mint}33`,
                      borderWidth: 1,
                      borderRadius: 12,
                      padding: 14,
                      marginBottom: 20,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        marginBottom: 9,
                      }}
                    >
                      <Ionicons
                        name="shield-checkmark"
                        size={19}
                        color={c.mintDim}
                        style={{ marginRight: 7 }}
                      />
                      <Text
                        style={{
                          color: c.textPrimary,
                          fontWeight: "700",
                          fontSize: 15,
                        }}
                      >
                        Payment will be sent to
                      </Text>
                    </View>
                    <Text
                      style={{
                        color: c.textPrimary,
                        fontWeight: "600",
                        fontSize: 15,
                        marginBottom: 3,
                      }}
                    >
                      {paystackSubaccount?.business_name || "Super Agent"}
                    </Text>
                    {paystackSubaccount?.settlement_bank && (
                      <Text
                        style={{
                          color: c.textMuted,
                          fontSize: 13,
                          marginBottom: 2,
                        }}
                      >
                        {paystackSubaccount.settlement_bank}
                      </Text>
                    )}
                  </View>
                )}
                <TouchableOpacity
                  style={{
                    backgroundColor: c.mint,
                    paddingHorizontal: 40,
                    paddingVertical: 16,
                    borderRadius: 12,
                    width: "100%",
                    alignItems: "center",
                    marginBottom: 15,
                    opacity: paystackLoading ? 0.7 : 1,
                  }}
                  onPress={async () => {
                    if (paystackLoading || isLoading) return;

                    setPaystackLoading(true);

                    try {
                      if (
                        initializePayment &&
                        typeof initializePayment === "function"
                      ) {
                        await initializePayment();
                      } else {
                        console.error("Paystack payment not initialized");
                        showError(
                          "Payment Error",
                          "Payment system not ready. Please wait a moment and try again.",
                        );
                      }
                    } catch (error) {
                      console.error("Payment initialization error:", error);
                      showError(
                        "Payment Error",
                        "Failed to initialize payment. Please try again.",
                      );
                    } finally {
                      // Reset loading after a short delay to allow Paystack to open
                      setTimeout(() => setPaystackLoading(false), 2000);
                    }
                  }}
                  disabled={paystackLoading || isLoading}
                >
                  <Text
                    style={{
                      color: c.onAccent,
                      fontSize: 18,
                      fontWeight: "bold",
                    }}
                  >
                    {paystackLoading || isLoading ? "Processing..." : "Pay Now"}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{
                    paddingVertical: 10,
                    paddingHorizontal: 20,
                  }}
                  onPress={() => setPaystackModalVisible(false)}
                >
                  <Text style={{ color: c.textMuted, fontSize: 16 }}>
                    Cancel
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            // Mobile implementation using WebView
            <WebView
              source={{
                html: generatePaystackHTML(
                  getAgentPaymentBreakdown()?.grossAmount ||
                    parseFloat(selectedBundle.price.replace("Ghc ", "")),
                  userEmail,
                  `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  resolvedSubaccountCode,
                  getAgentPaymentBreakdown()?.mainAccountAmount
                    ? Math.floor(
                        getAgentPaymentBreakdown().mainAccountAmount * 100,
                      )
                    : null,
                  paystackPublicKey,
                  isAgent && !isSuperAgentUser
                    ? paystackSubaccount?.business_name
                    : null,
                  isAgent && !isSuperAgentUser
                    ? paystackSubaccount?.settlement_bank
                    : null,
                  getAgentPaymentBreakdown()?.baseAmount ||
                    parseFloat(selectedBundle.price.replace("Ghc ", "")),
                  getAgentPaymentBreakdown()?.agentMarkup || 0,
                  getAgentPaymentBreakdown()?.transactionFee || 0,
                  isAgent && !isSuperAgentUser,
                  (getAgentPaymentBreakdown()?.baseAmount || 0) +
                    (getAgentPaymentBreakdown()?.agentMarkup || 0),
                ),
              }}
              style={{ flex: 1 }}
              userAgent="Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.106 Mobile Safari/537.36"
              scalesPageToFit={true}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              onMessage={async (event) => {
                const message = JSON.parse(event.nativeEvent.data);

                if (message.type === "success") {
                  setPaystackModalVisible(false);

                  try {
                    // Get current user
                    const {
                      data: { user },
                    } = await supabase.auth.getUser();

                    if (!user) {
                      showError("Authentication Error", "User not found");
                      return;
                    }

                    // Call Supabase edge function to verify payment and create order
                    const functionName = getEdgeFunctionName("verify-payment");
                    const { data, error } = await supabase.functions.invoke(
                      functionName,
                      {
                        body: {
                          reference: message.data.reference,
                          user_id: user.id,
                          offer_id: selectedBundle.id,
                          provider_package_id:
                            selectedBundle.package_id || selectedBundle.id,
                          package_name: selectedBundle.name,
                          package_type: selectedBundle.type || null,
                          package_size: selectedBundle.dataSize || null,
                          provider_type: selectedBundle.type || null,
                          provider_size: Number(
                            String(selectedBundle.dataSize || "").match(
                              /[\d.]+/,
                            )?.[0] || 0,
                          ),
                          amount:
                            getAgentPaymentBreakdown()?.grossAmount ||
                            parseFloat(
                              selectedBundle.price.replace("Ghc ", ""),
                            ),
                          network: network,
                          recipient_phone: isAgent
                            ? recipientPhone.trim().replace(/\s+/g, "")
                            : purchaseType === "self"
                              ? userPhone
                              : recipientPhone.trim().replace(/\s+/g, ""), // Clean phone number
                          super_agent_id: superAgentId,
                          paystack_subaccount_code: resolvedSubaccountCode,
                          base_price: selectedBundle.base_price || 0,
                          tier_extra: selectedBundle.tier_extra || 0,
                          transaction_fee:
                            getAgentPaymentBreakdown()?.transactionFee || 0,
                        },
                      },
                    );

                    if (error) {
                      console.error("[Purchase] Edge function failed:", {
                        function: functionName,
                        name: error.name,
                        message: error.message,
                        status: error.status,
                        details: error.context || error.error || null,
                      });
                      showError(
                        "Payment Verification Failed",
                        "Please contact support if payment was deducted",
                      );
                      return;
                    }

                    if (data.success) {
                      if (data.held) {
                        showError(
                          "Order Pending",
                          "Payment received, but the Super Agent wallet needs funding before this order can be fulfilled.",
                        );
                        return;
                      }

                      // Must pass the order id and type, matching the
                      // signature of dispatchProviderOrder. The previous call
                      // here passed the bundle and a phone number, so the
                      // function received order_id = NaN and a phone number as
                      // order_type, and the edge function rejected every mobile
                      // purchase with a 400 before contacting the provider.
                      const providerResult = await dispatchProviderOrder(
                        data.order.id,
                        data.is_agent_order ? "agent" : "regular",
                      );

                      if (providerResult.rejected) {
                        // Permanent failure - the order cannot be dispatched.
                        // Do not report this as a successful purchase.
                        showError(
                          "Order Could Not Be Delivered",
                          providerResult.errorMessage,
                        );
                        return;
                      }

                      if (!providerResult.dispatched) {
                        // Queued, not delivered. The payment is settled and the
                        // admin can retry once the provider is reachable.
                        showSuccess(
                          "Order Queued",
                          providerResult.deferred
                            ? "Your order is confirmed and is queued for delivery."
                            : "Your order is confirmed and is being processed. It will be delivered shortly.",
                        );
                        navigation.navigate("Receipt", {
                          transaction: {
                            id: data.order.id,
                            status: "pending",
                            offer_title: selectedBundle.name,
                            network,
                            data_amount: selectedBundle.name,
                            amount: data.order.amount,
                            created_at: data.order.created_at,
                            payment_reference: data.order.payment_reference,
                            user_email: userEmail,
                            phone: isAgent
                              ? recipientPhone
                              : purchaseType === "self"
                                ? userPhone
                                : recipientPhone,
                            country_code: "GH",
                            orderType: "user",
                          },
                        });
                        return;
                      }

                      // No client-side write-back of jehuca_order_id here.
                      // `dispatch-order` already persists jehuca_order_id,
                      // jehuca_order_status and jehuca_response on the order
                      // row using the service role. Repeating it from the app
                      // was a silent no-op: these tables are RLS-scoped and the
                      // client only holds the anon key, so the update was
                      // rejected while the code carried on as if it had
                      // succeeded.

                      showSuccess(
                        "Purchase Successful!",
                        `Your ${selectedBundle.name} data bundle has been purchased successfully!`,
                      );
                      // Navigate to receipt screen
                      navigation.navigate("Receipt", {
                        transaction: {
                          id: data.order.id,
                          status: "processing",
                          offer_title: selectedBundle.name,
                          network: network,
                          data_amount: selectedBundle.name,
                          amount: data.order.amount,
                          created_at: data.order.created_at,
                          payment_reference: data.order.payment_reference,
                          user_name:
                            user.user_metadata?.full_name ||
                            user.email?.split("@")[0] ||
                            "N/A",
                          user_email: user.email,
                          phone: isAgent
                            ? recipientPhone.trim().replace(/\s+/g, "")
                            : purchaseType === "self"
                              ? userPhone
                              : recipientPhone.trim().replace(/\s+/g, ""),
                          country_code: "GH",
                          orderType: "user",
                        },
                      });
                    } else {
                      showError(
                        "Payment Failed",
                        data.message || "Payment verification failed",
                      );
                    }
                  } catch (error) {
                    console.error("Payment verification error:", error);
                    showError(
                      "Payment Verification Failed",
                      "Please contact support if payment was deducted",
                    );
                  }
                } else if (message.type === "cancel") {
                  setPaystackModalVisible(false);
                  showError(
                    "Payment Cancelled",
                    "Payment was cancelled by user",
                  );
                }
              }}
            />
          )}
        </Modal>
      )}
    </View>
  );
}

// Cross-platform elevation. Mirrors HomeScreen/ProfileScreen: `boxShadow` for
// web (where `shadow*` flattens), native props elsewhere, palette tone.
const shadow = (elevation, shadowOpacity = 0.16, tone = "#000000") =>
  Platform.select({
    ios: {
      shadowColor: tone,
      shadowOffset: { width: 0, height: elevation },
      shadowOpacity,
      shadowRadius: elevation * 1.6,
    },
    android: { elevation },
    default: {
      boxShadow: `${tone}${Math.round(shadowOpacity * 255)
        .toString(16)
        .padStart(2, "0")} 0px ${elevation}px ${elevation * 1.8}px`,
    },
  });

const useDataStyles = (c) => useMemo(() => buildStyles(c), [c]);

// One stylesheet per colour scheme, rebuilt only when the scheme flips. The
// modal/payment styles that used to be a hardcoded light sheet are included
// here too, so the checkout sheets follow the scheme as well.
const buildStyles = (c) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.canvas,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingBottom: 36,
    },

    /* ---------- Network hero ---------- */
    hero: {
      borderRadius: 26,
      overflow: "hidden",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
      marginTop: 8,
      ...shadow(5, 0.18, c.shadow),
    },
    heroImage: {
      ...StyleSheet.absoluteFillObject,
    },
    // Explicit top/left/right/bottom rather than absoluteFill: on Android
    // absoluteFill inside a background image can collapse to zero height.
    heroScrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: c.adScrim,
    },
    heroContent: {
      padding: 18,
    },
    heroTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    heroHeadText: {
      flex: 1,
    },
    heroTitle: {
      fontFamily: fonts.display,
      fontSize: 22,
      color: c.textPrimary,
    },
    heroSubtitle: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textMuted,
      marginTop: 2,
    },
    heroCount: {
      fontFamily: fonts.bodySemi,
      fontSize: 11.5,
      color: c.mintDim,
      marginTop: 14,
    },
    networkBadgeLarge: {
      width: 48,
      height: 48,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
    },
    networkInitialLarge: {
      fontFamily: fonts.displayBold,
      fontSize: 22,
      color: "#04231F",
    },

    /* ---------- Agent tier banner ---------- */
    tierBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      marginTop: 14,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 16,
      backgroundColor: `${c.mint}12`,
      borderWidth: 1,
      borderColor: `${c.mint}33`,
    },
    tierBannerText: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textSecondary,
    },

    /* ---------- Family tabs ---------- */
    familyTabsWrap: {
      marginTop: 18,
    },
    familyTabsContent: {
      gap: 8,
      paddingRight: 20,
    },
    familyTab: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      paddingHorizontal: 14,
      height: 38,
      borderRadius: 999,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    familyTabActive: {
      backgroundColor: c.mint,
      borderColor: c.mint,
    },
    familyTabText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12.5,
      color: c.textSecondary,
    },
    familyTabTextActive: {
      color: c.onAccent,
    },
    familyTabCount: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceHover,
    },
    familyTabCountActive: {
      backgroundColor: "rgba(0, 0, 0, 0.18)",
    },
    familyTabCountText: {
      fontFamily: fonts.bodyBold,
      fontSize: 10.5,
      color: c.textMuted,
    },
    familyTabCountTextActive: {
      color: c.onAccent,
    },

    /* ---------- Bundle cards ---------- */
    bundleList: {
      gap: 10,
      marginTop: 16,
    },
    group: {
      gap: 10,
    },
    bundleCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 14,
      ...shadow(3, 0.14, c.shadow),
    },
    bundleBody: {
      flex: 1,
    },
    bundleHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
    },
    bundleType: {
      flex: 1,
      fontFamily: fonts.bodySemi,
      fontSize: 14.5,
      color: c.textPrimary,
    },
    networkBadge: {
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 999,
    },
    networkBadgeText: {
      fontFamily: fonts.bodyBold,
      fontSize: 9.5,
      letterSpacing: 0.6,
    },
    bundleMeta: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 12,
      gap: 14,
    },
    metaItem: {
      gap: 3,
    },
    metaDivider: {
      width: StyleSheet.hairlineWidth,
      height: 26,
      backgroundColor: c.hairline,
    },
    metaLabel: {
      fontFamily: fonts.body,
      fontSize: 10.5,
      color: c.textMuted,
      letterSpacing: 0.3,
    },
    metaValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: c.textSecondary,
    },
    metaValueStrong: {
      fontFamily: fonts.displayBold,
      fontSize: 15,
      color: c.mint,
    },
    bundleChevron: {
      marginLeft: 10,
    },

    /* ---------- Skeleton ---------- */
    skeletonBody: {
      flex: 1,
      gap: 9,
    },
    skeletonLine: {
      height: 12,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
      width: "60%",
    },
    skeletonLineShort: {
      height: 10,
      borderRadius: 5,
      backgroundColor: c.surfaceHover,
      width: "38%",
    },
    skeletonPrice: {
      height: 22,
      borderRadius: 8,
      backgroundColor: c.surfaceHover,
      width: 72,
    },

    /* ---------- Info card ---------- */
    infoCard: {
      marginTop: 24,
      backgroundColor: c.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 16,
    },
    infoHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 12,
    },
    infoTitle: {
      fontFamily: fonts.bodySemi,
      fontSize: 13.5,
      color: c.textPrimary,
    },
    infoList: {
      gap: 9,
    },
    infoRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
    },
    infoBullet: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: c.mintDim,
      marginTop: 7,
    },
    infoText: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 12.5,
      lineHeight: 18,
      color: c.textMuted,
    },

    /* ---------- Recipient / checkout modals ---------- */
    recipientModalOverlay: {
      flex: 1,
      backgroundColor: c.scrim,
      justifyContent: "flex-end",
    },
    recipientModalAvoidingView: {
      width: "100%",
    },
    recipientModalCard: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderWidth: 1,
      borderColor: c.hairline,
      maxHeight: "88%",
    },
    recipientModalContent: {
      padding: 22,
    },
    recipientModalHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      marginBottom: 18,
    },
    recipientModalTitle: {
      fontFamily: fonts.display,
      fontSize: 20,
      color: c.textPrimary,
    },
    recipientModalSubtitle: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textMuted,
      marginTop: 3,
    },
    recipientModalClose: {
      width: 34,
      height: 34,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceHover,
    },
    purchaseTypeButtons: {
      flexDirection: "row",
      gap: 10,
      marginBottom: 18,
    },
    purchaseTypeButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      height: 50,
      borderRadius: 16,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    purchaseTypeButtonActive: {
      backgroundColor: c.mint,
      borderColor: c.mint,
    },
    purchaseTypeButtonText: {
      fontFamily: fonts.bodySemi,
      fontSize: 13.5,
      color: c.textSecondary,
    },
    purchaseTypeButtonTextActive: {
      color: c.onAccent,
    },
    userPhoneContainer: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      padding: 14,
      borderRadius: 16,
      backgroundColor: c.surfaceSunken,
      marginBottom: 18,
    },
    userPhoneText: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 13,
      color: c.textSecondary,
    },
    phoneInputLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 11.5,
      color: c.textSecondary,
      letterSpacing: 0.3,
      marginBottom: 7,
    },
    phoneInputWrapper: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      height: 52,
      borderRadius: 16,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
      paddingHorizontal: 14,
      marginBottom: 16,
    },
    phoneIcon: {
      marginRight: 2,
    },
    phoneInput: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: 15,
      color: c.textPrimary,
      // Android adds its own vertical padding that misaligns the row.
      paddingVertical: 0,
    },
    recipientContinueButton: {
      height: 52,
      borderRadius: 999,
      backgroundColor: c.mint,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 4,
    },
    recipientContinueText: {
      fontFamily: fonts.bodyBold,
      fontSize: 15,
      color: c.onAccent,
    },

    /* ---------- Payment breakdown (web checkout) ---------- */
    paymentBreakdownRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: 8,
      marginTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.hairline,
    },
    paymentBreakdownLabel: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.textMuted,
    },
    paymentBreakdownValue: {
      fontFamily: fonts.bodySemi,
      fontSize: 12.5,
      color: c.textSecondary,
    },
    paymentBreakdownFee: {
      fontFamily: fonts.bodySemi,
      fontSize: 12.5,
      color: c.amber,
    },
    paymentBreakdownTotal: {
      borderTopColor: c.hairlineStrong,
    },
    paymentBreakdownTotalLabel: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.textPrimary,
    },
    paymentBreakdownTotalValue: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: c.mint,
    },
  });
