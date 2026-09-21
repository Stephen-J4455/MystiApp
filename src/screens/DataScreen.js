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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import colors from "../components/theme";
import { WebView } from "react-native-webview";
import { getEdgeFunctionName } from "../lib/env";
import { Modal } from "react-native";
import { Platform } from "react-native";
import { usePaystackPayment } from "../hooks/usePaystackPayment";
import { getPaystackPublicKey } from "../lib/supabase";

import {
  loadSubAgentPackages,
  formatBundleSizeFromDescriptor,
  fetchCatalogPackages,
} from "../services/superAgentService";

export default function DataScreen({ navigation, route }) {
  const { network } = route.params;
  const [selectedBundle, setSelectedBundle] = useState(null);
  const [bundles, setBundles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paystackModalVisible, setPaystackModalVisible] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [userPhone, setUserPhone] = useState("");
  const [purchaseType, setPurchaseType] = useState("self"); // 'self' or 'others'
  const [isAgent, setIsAgent] = useState(false);
  const [resolvedSubaccountCode, setResolvedSubaccountCode] = useState(null);
  const [superAgentId, setSuperAgentId] = useState(null);
  const [agentChecked, setAgentChecked] = useState(false);
  const [agentBalance, setAgentBalance] = useState(0);
  const [agentTier, setAgentTier] = useState(null);
  const { showError, showSuccess } = useNotification();
  const bundleSkeletonOpacity = useRef(new Animated.Value(0.6)).current;

  // Paystack payment handlers
  const handlePaymentSuccess = useCallback(
    async (response) => {
      console.log("Payment successful:", response);
      setPaystackModalVisible(false);

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          showError("Authentication Error", "User not found");
          return;
        }

        const { data, error } = await supabase.functions.invoke(
          getEdgeFunctionName("verify-payment"),
          {
            body: {
              reference: response.reference,
              user_id: user.id,
              offer_id: selectedBundle.id,
              amount: parseFloat(selectedBundle.price.replace("Ghc ", "")),
              network: network,
              recipient_phone:
                purchaseType === "self"
                  ? userPhone
                  : recipientPhone.trim().replace(/\s+/g, ""),
              super_agent_id: superAgentId,
              paystack_subaccount_code: resolvedSubaccountCode,
            },
          },
        );

        if (error) {
          console.error("Edge function error:", error);
          showError(
            "Payment Verification Failed",
            "Please contact support if payment was deducted",
          );
          return;
        }

        if (data.success) {
          showSuccess(
            "Purchase Successful!",
            `Your ${selectedBundle.name} data bundle has been purchased successfully!`,
          );
          navigation.navigate("Receipt", {
            transaction: {
              id: data.order.id,
              status: data.order.status,
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
              phone:
                purchaseType === "self"
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
      purchaseType,
      userPhone,
      recipientPhone,
      network,
      navigation,
      showError,
      showSuccess,
    ],
  );

  const handlePaymentClose = useCallback(() => {
    console.log("Payment cancelled");
    setPaystackModalVisible(false);
    showError("Payment Cancelled", "Payment was cancelled by user");
  }, [showError]);

  const [paystackPublicKey, setPaystackPublicKey] = useState("");

  useEffect(() => {
    let active = true;

    const loadPaystackPublicKey = async () => {
      const key = await getPaystackPublicKey();
      if (active) {
        setPaystackPublicKey(key);
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

    return {
      reference: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      email: userEmail,
      amount: Math.floor(
        parseFloat(selectedBundle.price.replace("Ghc ", "")) * 100,
      ),
      currency: "GHS",
      publicKey: paystackPublicKey,
      subaccount: resolvedSubaccountCode || undefined,
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
  ]);

  const { initializePayment, isLoaded, isLoading } =
    usePaystackPayment(paystackConfig);

  // Add loading state for Paystack initialization
  const [paystackLoading, setPaystackLoading] = useState(false);

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
        setUserPhone(user.user_metadata?.phone || "");

        const assignedSuperAgentId =
          user.user_metadata?.super_agent_id ||
          user.user_metadata?.superAgentId ||
          null;
        setSuperAgentId(assignedSuperAgentId);
        setAgentTier(user.user_metadata?.tier_name || null);

        const isUserRoleAgent =
          user.user_metadata?.role?.toLowerCase() === "agent" ||
          Boolean(assignedSuperAgentId);

        // Check if user is an agent
        try {
          const { data: wallet, error: walletError } = await supabase
            .from("agent_wallet")
            .select("*")
            .eq("agent_id", user.id)
            .single();

          const hasWallet = !walletError && wallet !== null;
          const agentStatus = hasWallet || isUserRoleAgent;
          setIsAgent(agentStatus);
          if (wallet) {
            setAgentBalance(wallet.balance || 0);
          }
        } catch (error) {
          console.error("Error checking agent status:", error);
          setIsAgent(isUserRoleAgent);
        }

        // If this user is a sub-agent of a super agent, ask the edge
        // function for the super-agent's Paystack subaccount so the
        // purchase is routed through it.
        if (assignedSuperAgentId) {
          try {
            const { data: subaccountResponse } =
              await supabase.functions.invoke(
                getEdgeFunctionName("super-agent-user-management"),
                { body: { action: "getPaystackSubaccount" } },
              );
            const record = subaccountResponse?.subaccount || null;
            if (record?.is_active && record.subaccount_code) {
              setResolvedSubaccountCode(record.subaccount_code);
            }
          } catch (subaccountError) {
            console.warn(
              "Could not resolve Paystack subaccount for data purchase:",
              subaccountError,
            );
          }
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

        const assignedSuperAgentId =
          user.user_metadata?.super_agent_id ||
          user.user_metadata?.superAgentId ||
          superAgentId ||
          null;

        // Sub-agents buy from the packages their super agent published for the
        // tier they were granted (falling back to the super agent's General prices).
        if (assignedSuperAgentId) {
          const agentPackagesResult = await loadSubAgentPackages({
            user,
            network,
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
                id: agentOffer.package_id
                  ? String(agentOffer.package_id)
                  : String(agentOffer.id),
                superAgentOfferId:
                  agentOffer.superAgentOfferId || agentOffer.id,
                network: String(agentOffer.network || "").toUpperCase(),
                type: String(agentOffer.type || descriptor).toUpperCase(),
                name:
                  agentOffer.title ||
                  `${agentOffer.network} — ${descriptor}`,
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
                tierName: agentOffer.tier_name || null,
              };
            });

          setBundles(mappedBundles);
          setLoading(false);
          return;
        }

        // Direct top-level agent without a super agent: load from catalog
        const catalogOffers = await fetchCatalogPackages();
        const filteredOffers = (catalogOffers || []).filter(
          (pkg) => pkg.network?.toUpperCase() === network.toUpperCase(),
        );
        const mappedBundles = filteredOffers.map((pkg) => ({
          id: pkg.id,
          network: pkg.network,
          type: pkg.type,
          name: `${pkg.network} — ${pkg.type}`,
          price: `Ghc ${(pkg.price / 100).toFixed(2)}`,
          dataSize: `${pkg.size} GB`,
        }));
        setBundles(mappedBundles);
        setLoading(false);
        return;
      }

      // Regular customer
      const offers = await fetchCatalogPackages();

      const filteredOffers = (offers || []).filter(
        (pkg) => pkg.network?.toUpperCase() === network.toUpperCase(),
      );

      const mappedBundles = filteredOffers.map((pkg) => ({
        id: pkg.id,
        network: pkg.network,
        type: pkg.type,
        name: `${pkg.network} — ${pkg.type}`,
        price: `Ghc ${(pkg.price / 100).toFixed(2)}`,
        dataSize: `${pkg.size} GB`,
      }));
      setBundles(mappedBundles);
    } catch (error) {
      console.error("Error:", error);
      showError("Error", "Failed to load data bundles");
      setBundles([]);
    } finally {
      setLoading(false);
    }
  };

  const bundlesByNetwork = useMemo(() => {
    const grouped = {};
    bundles.forEach((bundle) => {
      const networkName = bundle.name.split(" — ")[0]?.trim() || "Other";
      if (!grouped[networkName]) {
        grouped[networkName] = [];
      }
      grouped[networkName].push(bundle);
    });
    return grouped;
  }, [bundles]);

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

      // Extract price as number (remove 'Ghc ' prefix)
      const price = parseFloat(bundle.price.replace("Ghc ", ""));

      if (isNaN(price)) {
        showError("Error", "Invalid bundle price");
        return;
      }

      // Open Paystack payment modal
      setSelectedBundle(bundle);
      setPaystackModalVisible(true);
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

      // Basic phone number validation (Ghana format - more flexible)
      const phoneRegex = /^(\+?233|0)?[2356789]\d{8}$/;
      const cleanPhone = recipientPhone.trim().replace(/\s+/g, ""); // Remove spaces

      if (!phoneRegex.test(cleanPhone)) {
        showError(
          "Invalid Phone Number",
          "Please enter a valid Ghana phone number (e.g., 0532973455 or +233532973455)",
        );
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
      setPaystackModalVisible(true);
    } catch (error) {
      console.error("Purchase error:", error);
      showError("Error", "Failed to initiate purchase");
    }
  };

  const handleAgentPurchase = async (bundle) => {
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

      // Validate recipient name and phone number
      if (!recipientName.trim()) {
        showError(
          "Recipient Name Required",
          "Please enter the recipient's name",
        );
        return;
      }

      if (!recipientPhone.trim()) {
        showError(
          "Phone Number Required",
          "Please enter the recipient's phone number",
        );
        return;
      }

      // Ghana phone number validation (more flexible)
      const phoneRegex = /^(\+?233|0)?[2356789]\d{8}$/;
      const cleanPhone = recipientPhone.trim().replace(/\s+/g, ""); // Remove spaces

      if (!phoneRegex.test(cleanPhone)) {
        showError(
          "Invalid Phone Number",
          "Please enter a valid Ghana phone number (e.g., 0532973455 or +233532973455)",
        );
        return;
      }

      // Extract price as number (remove 'Ghc ' prefix)
      const price = parseFloat(bundle.price.replace("Ghc ", ""));

      if (isNaN(price)) {
        showError("Error", "Invalid bundle price");
        return;
      }

      // Check agent wallet balance
      const { data: walletData, error: walletError } = await supabase
        .from("agent_wallet")
        .select("balance")
        .eq("agent_id", user.id)
        .single();

      if (walletError) {
        console.error("Wallet check error:", walletError);
        showError("Error", "Failed to check wallet balance");
        return;
      }

      if (!walletData || walletData.balance < price) {
        showError(
          "Insufficient Balance",
          `Your wallet balance (GHS ${
            walletData?.balance || 0
          }) is not enough for this purchase (GHS ${price})`,
        );
        return;
      }

      // Show loading
      setLoading(true);

      // First, deduct from wallet
      const { error: walletUpdateError } = await supabase
        .from("agent_wallet")
        .update({ balance: walletData.balance - price })
        .eq("agent_id", user.id);

      if (walletUpdateError) {
        console.error("Wallet deduction error:", walletUpdateError);
        showError("Error", "Failed to deduct from wallet");
        setLoading(false);
        return;
      }

      // Update local balance
      setAgentBalance(walletData.balance - price);

      // Then create order in agent_orders table
      const { data: orderData, error: orderError } = await supabase
        .from("agent_orders")
        .insert({
          agent_id: user.id,
          offer_id: bundle.id,
          offer_title: bundle.name,
          network: network,
          super_agent_id: superAgentId || null,
          channel: "Agent",
          device_token: cleanPhone,
          recipient_name: recipientName.trim(),
          recipient_phone: cleanPhone,
          amount: price,
          status: "pending",
          transaction_status: "pending",
        })
        .select("id")
        .single();

      if (orderError) {
        console.error("Order creation error:", orderError);
        // Attempt to refund wallet if order creation failed
        await supabase
          .from("agent_wallet")
          .update({ balance: walletData.balance })
          .eq("agent_id", user.id);
        setAgentBalance(walletData.balance);
        showError("Error", "Failed to create order");
        setLoading(false);
        return;
      }

      if (true) {
        // Proceed to send notification via Edge Function directly
        // Send push notification to agent
        try {
          const { error: agentNotifyError } = await supabase.functions.invoke(
            getEdgeFunctionName("send-notification"),
            {
              body: {
                userId: user.id,
                title: "Agent Order Successful",
                message: `${bundle.name} data bundle purchased for ${recipientName.trim()}`,
                type: "agent_order",
              },
            },
          );

          if (agentNotifyError) {
            console.error(
              "Failed to send agent notification:",
              agentNotifyError,
            );
          } else {
            console.log("Agent notification sent successfully");
          }

          // Notify admins about the new agent order
          try {
            await supabase.functions.invoke(
              getEdgeFunctionName("send-notification"),
              {
                body: {
                  sendToAdmins: true,
                  title: "New Agent Order Received",
                  message: `Agent ${user.email} purchased ${bundle.name} for ${recipientName.trim()} (${cleanPhone}). Amount: GHS ${price}`,
                  type: "agent_order",
                },
              },
            );
            console.log("Admin notification for agent order sent successfully");
          } catch (adminPushError) {
            console.error(
              "Error notifying admins about agent order:",
              adminPushError,
            );
          }
        } catch (pushError) {
          console.error("Error sending agent push notification:", pushError);
        }
      }

      // Note: Admin notifications for agent orders should be handled via database
      // triggers or a separate edge function to avoid permission issues

      // Success - navigate to receipt screen
      navigation.navigate("Receipt", {
        transaction: {
          id: orderData.id,
          status: "pending",
          offer_title: bundle.name,
          network: bundle.network,
          data_amount: bundle.name,
          amount: price,
          created_at: new Date().toISOString(),
          user_name: recipientName.trim(),
          phone: cleanPhone,
          payment_reference: `AGENT-${orderData.id}`,
          orderType: "agent",
        },
      });

      // Reset form
      setRecipientName("");
      setRecipientPhone("");
      setSelectedBundle(null);
      setLoading(false);

      // Show success message
      showSuccess(
        "Purchase Successful!",
        `Data bundle purchased successfully for ${recipientName.trim()}!`,
      );
    } catch (error) {
      console.error("Agent purchase error:", error);
      showError("Error", "Failed to complete purchase");
      setLoading(false);
    }
  };

  const generatePaystackHTML = (amount, email, reference, subaccountCode, paystackPublicKey) => {
    const safeKey = paystackPublicKey ? String(paystackPublicKey).replace(/\\/g, "\\\\").replace(/'/g, "\\'") : "";
    const safeEmail = String(email || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const safeRef = String(reference || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const safeSub = subaccountCode ? String(subaccountCode).replace(/\\/g, "\\\\").replace(/'/g, "\\'") : "";
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
            background: linear-gradient(135deg, var(--primary), var(--secondary));
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
            padding: 20px;
            border-radius: 16px;
            margin-bottom: 35px;
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
            font-size: 32px;
            font-weight: 900;
            color: #1A1A1A;
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
          </div>
          
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
            var handler = PaystackPop.setup(setupOptions);
            handler.openIframe();
          };
        </script>
      </body>
      </html>
    `;
  };

  const getNetworkColor = (networkName) => {
    switch (networkName) {
      case "MTN":
        return "#ffcc00";
      case "TELECEL":
        return "#00ccff";
      case "AIRTELTIGO":
        return "#ff6600";
      default:
        return colors.primary;
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

  const renderBundlePlaceholders = () => (
    <View>
      {[0, 1, 2, 3, 4].map((index) => (
        <Animated.View
          key={`bundle-placeholder-${index}`}
          style={[
            styles.bundlePlaceholderCard,
            { opacity: bundleSkeletonOpacity },
          ]}
        >
          <View style={styles.bundlePlaceholderLeft}>
            <View style={styles.bundlePlaceholderLine} />
            <View style={styles.bundlePlaceholderLineShort} />
          </View>
          <View style={styles.bundlePlaceholderPrice} />
        </Animated.View>
      ))}
    </View>
  );

  return (
    <View style={styles.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="dark-content"
      />

      {/* Floating Back Button */}
      <TouchableOpacity
        style={styles.floatingBackButton}
        onPress={() => navigation.goBack()}
      >
        <View style={styles.backButtonCircle}>
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </View>
      </TouchableOpacity>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.networkHeader}>
          {getNetworkImage(displayNetwork) ? (
            <ImageBackground
              source={getNetworkImage(displayNetwork)}
              style={styles.networkHeaderBackground}
              resizeMode="cover"
            >
              <View style={styles.networkOverlay}>
                <View
                  style={[
                    styles.networkIcon,
                    { backgroundColor: getNetworkColor(displayNetwork) },
                  ]}
                >
                  <Text style={styles.networkInitial}>
                    {displayNetwork.charAt(0)}
                  </Text>
                </View>
                <Text style={[styles.networkTitle, { color: "#fff" }]}>
                  {displayNetwork} Network
                </Text>
                <Text style={[styles.networkSubtitle, { color: "#fff" }]}>
                  Choose your preferred data bundle
                </Text>
              </View>
            </ImageBackground>
          ) : (
            <View style={styles.networkHeaderContent}>
              <View
                style={[
                  styles.networkIcon,
                  { backgroundColor: getNetworkColor(displayNetwork) },
                ]}
              >
                <Text style={styles.networkInitial}>
                  {displayNetwork.charAt(0)}
                </Text>
              </View>
              <Text style={styles.networkTitle}>{displayNetwork} Network</Text>
              <Text style={styles.networkSubtitle}>
                Choose your preferred data bundle
              </Text>
            </View>
          )}
        </View>

        {/* Super agent package source - shown to sub-agents only */}
        {isAgent && (
          <View style={styles.agentTierBanner}>
            <Ionicons name="pricetags" size={18} color={colors.primary} />
            <Text style={styles.agentTierBannerText}>
              {agentTier
                ? `Packages for the ${agentTier} tier — prices set by your super agent.`
                : "Packages and prices set by your super agent."}
            </Text>
          </View>
        )}

        {/* Purchase Type Selection - Hidden for Agents */}
        {!isAgent && (
          <View style={styles.purchaseTypeContainer}>
            <Text style={styles.purchaseTypeLabel}>
              Who is this purchase for?
            </Text>
            <View style={styles.purchaseTypeButtons}>
              <TouchableOpacity
                style={[
                  styles.purchaseTypeButton,
                  purchaseType === "self" && styles.purchaseTypeButtonActive,
                ]}
                onPress={() => setPurchaseType("self")}
              >
                <Ionicons
                  name="person"
                  size={18}
                  color={
                    purchaseType === "self" ? colors.white : colors.primary
                  }
                />
                <Text
                  style={[
                    styles.purchaseTypeButtonText,
                    purchaseType === "self" &&
                      styles.purchaseTypeButtonTextActive,
                  ]}
                >
                  For Myself
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.purchaseTypeButton,
                  purchaseType === "others" && styles.purchaseTypeButtonActive,
                ]}
                onPress={() => setPurchaseType("others")}
              >
                <Ionicons
                  name="people"
                  size={18}
                  color={
                    purchaseType === "others" ? colors.white : colors.primary
                  }
                />
                <Text
                  style={[
                    styles.purchaseTypeButtonText,
                    purchaseType === "others" &&
                      styles.purchaseTypeButtonTextActive,
                  ]}
                >
                  For Others
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Show user's phone when self is selected - Hidden for Agents */}
        {!isAgent && purchaseType === "self" && userPhone && (
          <View style={styles.userPhoneContainer}>
            <Ionicons name="phone-portrait" size={20} color={colors.primary} />
            <Text style={styles.userPhoneText}>
              Data will be sent to: {userPhone}
            </Text>
          </View>
        )}

        {/* Phone Number Input for Others - Always shown for Agents */}
        {(purchaseType === "others" || isAgent) && (
          <View style={styles.phoneInputContainer}>
            <Text style={styles.phoneInputLabel}>
              {isAgent ? "Recipient Details" : "Recipient Phone Number"}
            </Text>
            {isAgent && (
              <View style={styles.phoneInputWrapper}>
                <Ionicons
                  name="person"
                  size={20}
                  color={colors.secondary}
                  style={styles.phoneIcon}
                />
                <TextInput
                  style={styles.phoneInput}
                  placeholder="Enter recipient name"
                  placeholderTextColor={colors.secondary}
                  value={recipientName}
                  onChangeText={setRecipientName}
                />
              </View>
            )}
            <View style={styles.phoneInputWrapper}>
              <Ionicons
                name="call"
                size={20}
                color={colors.secondary}
                style={styles.phoneIcon}
              />
              <TextInput
                style={styles.phoneInput}
                placeholder="Enter phone number (e.g., 0532973455)"
                placeholderTextColor={colors.secondary}
                value={recipientPhone}
                onChangeText={setRecipientPhone}
                keyboardType="phone-pad"
                maxLength={13}
              />
            </View>
            <Text style={styles.phoneInputHint}>
              {isAgent
                ? "Enter the recipient's name and phone number for the data bundle"
                : "Enter the phone number that will receive the data bundle"}
            </Text>
          </View>
        )}

        <View style={styles.bundlesContainer}>
          {loading || !agentChecked ? (
            renderBundlePlaceholders()
          ) : bundles.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="wifi" size={64} color={colors.tint} />
              <Text style={styles.emptyTitle}>No Data Bundles</Text>
              <Text style={styles.emptyMessage}>
                {isAgent
                  ? "Your super agent has not published packages for this network in your tier yet."
                  : `No data bundles available for ${displayNetwork} at the moment.`}
              </Text>
            </View>
          ) : (
            Object.entries(bundlesByNetwork).map(([networkName, networkBundles]) => (
              <View key={networkName} style={{ marginBottom: 20 }}>
                <View style={styles.networkSectionHeader}>
                  <Text style={styles.networkSectionTitle}>{networkName} Network</Text>
                  <Text style={styles.networkSectionSubtitle}>
                    {networkBundles.length} {networkBundles.length === 1 ? "bundle" : "bundles"} available
                  </Text>
                </View>
                {networkBundles.map((bundle) => (
                  <TouchableOpacity
                    key={bundle.id}
                    style={styles.bundleCard}
                    onPress={() => {
                      if (isAgent) {
                        handleAgentPurchase(bundle);
                      } else if (purchaseType === "self") {
                        handlePurchaseForSelf(bundle);
                      } else {
                        handlePurchaseForOthers(bundle);
                      }
                    }}
                  >
                    <View style={styles.bundleCardContent}>
                      <View style={styles.bundleInfo}>
                        <View style={styles.bundleHeader}>
                          <View style={styles.networkBadge}>
                            <Text style={styles.networkBadgeText}>{bundle.network}</Text>
                          </View>
                          <Text style={styles.bundleType}>{bundle.type}</Text>
                        </View>
                        <View style={styles.bundleDetailsRow}>
                          <View style={styles.bundleDetail}>
                            <Text style={styles.bundleDetailLabel}>Data</Text>
                            <Text style={styles.bundleDetailValue}>{bundle.dataSize}</Text>
                          </View>
                          <View style={styles.bundleDetail}>
                            <Text style={styles.bundleDetailLabel}>Bundle</Text>
                            <Text style={styles.bundleDetailValue}>{bundle.type}</Text>
                          </View>
                        </View>
                      </View>
                      <View style={styles.bundlePriceContainer}>
                        <Text style={styles.bundlePrice}>{bundle.price}</Text>
                        <Text style={styles.bundlePriceLabel}>Price</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            ))
          )}
        </View>

        <View style={styles.infoSection}>
          <Text style={styles.infoTitle}>Important Information</Text>
          <Text style={styles.infoText}>
            • Data bundles are automatically activated upon purchase{"\n"}•
            Validity periods start from the time of activation{"\n"}• Unused
            data expires at the end of the validity period{"\n"}• All prices are
            inclusive of applicable taxes
          </Text>
        </View>
      </ScrollView>

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
                      backgroundColor: colors.light,
                      justifyContent: "center",
                      alignItems: "center",
                      marginBottom: 15,
                    }}
                  >
                    <Ionicons name="card" size={30} color={colors.primary} />
                  </View>
                  <Text
                    style={{
                      fontSize: 24,
                      fontWeight: "bold",
                      color: colors.primary,
                      textAlign: "center",
                    }}
                  >
                    Complete Your Payment
                  </Text>
                </View>
                {/* Amount display */}
                <View
                  style={{
                    backgroundColor: colors.light,
                    paddingHorizontal: 20,
                    paddingVertical: 15,
                    borderRadius: 12,
                    marginBottom: 30,
                    width: "100%",
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 16,
                      color: colors.secondary,
                      marginBottom: 5,
                    }}
                  >
                    Amount to Pay
                  </Text>
                  <Text
                    style={{
                      fontSize: 28,
                      fontWeight: "bold",
                      color: colors.primary,
                    }}
                  >
                    GHS{" "}
                    {parseFloat(
                      selectedBundle.price.replace("Ghc ", ""),
                    ).toFixed(2)}
                  </Text>
                </View>
                <TouchableOpacity
                  style={{
                    backgroundColor: colors.primary,
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
                    console.log("Initializing Paystack payment...");

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
                      color: "white",
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
                  <Text style={{ color: colors.secondary, fontSize: 16 }}>
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
                  parseFloat(selectedBundle.price.replace("Ghc ", "")),
                  userEmail,
                  `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  resolvedSubaccountCode,
                  paystackPublicKey,
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
                    const { data, error } = await supabase.functions.invoke(
                      getEdgeFunctionName("verify-payment"),
                      {
                        body: {
                          reference: message.data.reference,
                          user_id: user.id,
                          offer_id: selectedBundle.id,
                          amount: parseFloat(
                            selectedBundle.price.replace("Ghc ", ""),
                          ),
                          network: network,
                          recipient_phone:
                            purchaseType === "self"
                              ? userPhone
                              : recipientPhone.trim().replace(/\s+/g, ""), // Clean phone number
                          super_agent_id: superAgentId,
                          paystack_subaccount_code: resolvedSubaccountCode,
                        },
                      },
                    );

                    if (error) {
                      console.error("Edge function error:", error);
                      showError(
                        "Payment Verification Failed",
                        "Please contact support if payment was deducted",
                      );
                      return;
                    }

                    if (data.success) {
                      showSuccess(
                        "Purchase Successful!",
                        `Your ${selectedBundle.name} data bundle has been purchased successfully!`,
                      );
                      // Navigate to receipt screen
                      navigation.navigate("Receipt", {
                        transaction: {
                          id: data.order.id,
                          status: data.order.status,
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
                          phone:
                            purchaseType === "self"
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.white,
  },
  floatingBackButton: {
    position: "absolute",
    top: 50,
    left: 20,
    zIndex: 10,
  },
  backButtonCircle: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: "rgba(255, 255, 255, 0.9)",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 15,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.white,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
  },
  headerTitleContainer: {
    flex: 1,
    alignItems: "center",
  },
  agentBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginTop: 4,
  },
  agentBadgeText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: "bold",
    marginLeft: 4,
  },
  balanceContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
  },
  balanceText: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: "600",
    marginLeft: 4,
  },
  content: {
    flex: 1,
    paddingTop: 25,
  },
  networkHeader: {
    margin: 20,
    borderRadius: 24,
    overflow: "hidden",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  networkHeaderBackground: {
    height: 180,
    width: "100%",
  },
  networkHeaderContent: {
    alignItems: "center",
    padding: 20,
    backgroundColor: colors.white,
    height: 150,
    justifyContent: "center",
  },
  networkOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  networkIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 10,
    borderWidth: 3,
    borderColor: colors.white,
  },
  networkInitial: {
    fontSize: 28,
    fontWeight: "bold",
    color: colors.white,
  },
  networkTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.white,
    marginBottom: 4,
  },
  networkSubtitle: {
    fontSize: 14,
    color: colors.white,
    opacity: 0.9,
  },
  bundlesContainer: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  bundleCard: {
    borderRadius: 24,
    marginBottom: 15,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    overflow: "hidden",
  },
  bundlePlaceholderCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 24,
    marginBottom: 15,
    padding: 20,
    backgroundColor: colors.white,
  },
  bundlePlaceholderLeft: {
    flex: 1,
    marginRight: 16,
  },
  bundlePlaceholderLine: {
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.border,
    width: "70%",
    marginBottom: 8,
  },
  bundlePlaceholderLineShort: {
    height: 10,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: "50%",
  },
  bundlePlaceholderPrice: {
    height: 20,
    width: 70,
    borderRadius: 10,
    backgroundColor: colors.border,
  },
  bundleCardContent: {
    padding: 20,
    backgroundColor: colors.white,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  bundleInfo: {
    flex: 1,
  },
  bundleHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  bundleType: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
  },
  networkBadge: {
    backgroundColor: colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 8,
  },
  networkBadgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: "bold",
  },
  bundleDetailsRow: {
    flexDirection: "row",
    marginTop: 8,
    gap: 16,
  },
  bundleDetail: {
    alignItems: "flex-start",
  },
  bundleDetailLabel: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.5,
    marginBottom: 2,
  },
  bundleDetailValue: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.dark,
  },
  bundlePriceContainer: {
    backgroundColor: colors.light,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "flex-end",
  },
  bundlePrice: {
    fontSize: 22,
    fontWeight: "800",
    color: colors.primary,
  },
  bundlePriceLabel: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.5,
    marginTop: 2,
  },
  purchaseTypeContainer: {
    backgroundColor: colors.white,
    marginHorizontal: 20,
    marginVertical: 10,
    padding: 20,
    borderRadius: 24,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  purchaseTypeLabel: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.dark,
    marginBottom: 15,
    textAlign: "center",
  },
  purchaseTypeButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.light,
    borderRadius: 16,
    padding: 4,
  },
  purchaseTypeButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
  purchaseTypeButtonActive: {
    backgroundColor: colors.primary,
    elevation: 4,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  purchaseTypeButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.dark,
    opacity: 0.7,
    marginLeft: 8,
  },
  purchaseTypeButtonTextActive: {
    color: colors.white,
    opacity: 1,
  },
  phoneInputContainer: {
    backgroundColor: colors.white,
    marginHorizontal: 20,
    marginVertical: 10,
    padding: 20,
    borderRadius: 24,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  phoneInputLabel: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.dark,
    marginBottom: 12,
  },
  phoneInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 15,
    backgroundColor: colors.light,
  },
  phoneInput: {
    flex: 1,
    fontSize: 16,
    color: colors.dark,
    paddingVertical: 14,
  },
  phoneInputHint: {
    fontSize: 12,
    color: colors.dark,
    opacity: 0.5,
    marginTop: 8,
    fontStyle: "italic",
  },
  userPhoneContainer: {
    backgroundColor: colors.light,
    marginHorizontal: 20,
    marginBottom: 20,
    padding: 15,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.primary,
    opacity: 0.8,
  },
  userPhoneText: {
    fontSize: 14,
    color: colors.primary,
    marginLeft: 10,
    fontWeight: "600",
  },
  purchaseButton: {
    backgroundColor: colors.light,
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 10,
  },
  purchaseButtonActive: {
    backgroundColor: colors.primary,
  },
  purchaseButtonText: {
    fontSize: 16,
    fontWeight: "bold",
    color: colors.primary,
  },
  purchaseButtonTextActive: {
    color: colors.white,
  },
  infoSection: {
    backgroundColor: colors.white,
    marginHorizontal: 20,
    marginBottom: 40,
    padding: 20,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.dark,
    marginBottom: 10,
  },
  infoText: {
    fontSize: 13,
    color: colors.dark,
    opacity: 0.7,
    lineHeight: 20,
  },
  loadingContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
  },
  loadingText: {
    fontSize: 14,
    color: colors.dark,
    opacity: 0.5,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  networkSectionHeader: {
    backgroundColor: colors.white,
    marginHorizontal: 20,
    marginBottom: 12,
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  networkSectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
  },
  networkSectionSubtitle: {
    fontSize: 13,
    color: colors.dark,
    opacity: 0.5,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: colors.dark,
    marginTop: 20,
    marginBottom: 10,
  },
  emptyMessage: {
    fontSize: 14,
    color: colors.dark,
    opacity: 0.5,
    textAlign: "center",
    paddingHorizontal: 40,
  },
  agentTierBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.tint,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 20,
    marginBottom: 16,
  },
  agentTierBannerText: {
    flex: 1,
    marginLeft: 10,
    color: colors.dark,
    fontSize: 13,
    lineHeight: 19,
  },
});
