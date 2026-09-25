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
import { invokeEdgeFunction } from "../lib/edgeFunctions.js";
import { Modal } from "react-native";
import { Platform } from "react-native";
import { usePaystackPayment } from "../hooks/usePaystackPayment";
import { getPaystackPublicKey } from "../lib/supabase";
import { getEdgeFunctionName } from "../lib/env";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import {
  loadSubAgentPackages,
  formatBundleSizeFromDescriptor,
  fetchCatalogPackages,
} from "../services/superAgentService";
import {
  fetchPaymentChargeSettings,
  getTransactionChargeAmount,
} from "../lib/paymentSettings";

export default function DataScreen({ navigation, route }) {
  const { network } = route.params;
  const [selectedBundle, setSelectedBundle] = useState(null);
  const [bundles, setBundles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paystackModalVisible, setPaystackModalVisible] = useState(false);
  const [directPaystackRequested, setDirectPaystackRequested] = useState(false);
  const [recipientModalVisible, setRecipientModalVisible] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [userPhone, setUserPhone] = useState("");
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

  const dispatchProviderOrder = useCallback(
    async (bundle, phone) => {
      const functionName = getEdgeFunctionName("make-orders");
      const rawSize = Number(
        bundle.size || String(bundle.dataSize || "").match(/[\d.]+/)?.[0] || 0,
      );
      const rawType = String(bundle.type || bundle.name || "").toUpperCase();
      const providerType = rawType.includes("BIG TIME")
        ? "BIG TIME"
        : rawType.includes("ISHARE")
          ? "ISHARE"
          : rawType.split(/[(-]/)[0].trim();
      const packageRequest = {
        packageId: String(bundle.package_id || bundle.id),
        size: Math.round(rawSize * 1000),
        network: String(bundle.network || network).toUpperCase(),
        type: providerType,
        phone: String(phone || "").replace(/\s+/g, ""),
      };

      console.log("[Purchase] Calling edge function:", functionName);
      const { data, error } = await supabase.functions.invoke(functionName, {
        body: { packages: [packageRequest] },
      });

      const debugPayload = {
        function: functionName,
        request: { packages: [packageRequest] },
        response: data || null,
        error: error?.message || null,
        accepted: Boolean(
          !error &&
          data?.status === true &&
          (data?.payload?.orderId || data?.payload?.orders?.length),
        ),
      };

      console.log("[Jehuca debug] make-orders:", debugPayload);
      return {
        data,
        error,
        accepted: debugPayload.accepted,
      };
    },
    [network],
  );

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

        const functionName = getEdgeFunctionName("verify-payment");
        console.log("[Purchase] Calling edge function:", functionName);
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
            recipient_name: isAgent ? recipientName.trim() : null,
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

          const providerResult = await dispatchProviderOrder(
            selectedBundle,
            isAgent
              ? recipientPhone
              : purchaseType === "self"
                ? userPhone
                : recipientPhone,
          );

          if (providerResult.error || !providerResult.accepted) {
            showError(
              "Provider Order Failed",
              "Payment was verified, but Jehucal did not accept the order. Contact support with the payment reference.",
            );
            return;
          }

          const providerOrderId =
            providerResult.data?.payload?.orderId ||
            providerResult.data?.orderId ||
            providerResult.data?.payload?.orders?.[0]?.id ||
            null;
          const providerStatus =
            providerResult.data?.payload?.orders?.[0]?.status ||
            providerResult.data?.status ||
            "accepted";
          await supabase
            .from(data.is_agent_order ? "agent_orders" : "orders")
            .update({
              jehuca_order_id: providerOrderId,
              jehuca_order_status: providerStatus,
              jehuca_response: providerResult.data || null,
            })
            .eq("id", data.order.id);
          await supabase
            .from("payment_transactions")
            .update({
              jehuca_order_id: providerOrderId,
              jehuca_order_status: providerStatus,
              jehuca_response: providerResult.data || null,
            })
            .eq("payment_reference", data.order.payment_reference);

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
      recipientName,
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
    console.log("Payment cancelled");
    setPaystackModalVisible(false);
    showError("Payment Cancelled", "Payment was cancelled by user");
  }, [showError]);

  const [paystackPublicKey, setPaystackPublicKey] = useState("");
  const [paystackKeyError, setPaystackKeyError] = useState(false);

  useEffect(() => {
    let active = true;

    const loadPaystackPublicKey = async () => {
      try {
        console.log(
          "[Purchase] Calling edge function:",
          getEdgeFunctionName("health"),
        );
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
        setUserPhone(user.user_metadata?.phone || "");

        const assignedSuperAgentId =
          user.user_metadata?.super_agent_id ||
          user.user_metadata?.superAgentId ||
          user.app_metadata?.super_agent_id ||
          user.app_metadata?.superAgentId ||
          null;
        setSuperAgentId(assignedSuperAgentId);
        setAgentTier(
          user.user_metadata?.tier_name || user.app_metadata?.tier_name || null,
        );

        const normalizedRole = String(
          user.user_metadata?.role || user.app_metadata?.role || "",
        ).toLowerCase();
        setIsSuperAgentUser(
          normalizedRole === "superagent" || normalizedRole === "super_agent",
        );
        const isUserRoleAgent =
          normalizedRole === "agent" ||
          normalizedRole === "sub_agent" ||
          normalizedRole === "superagent" ||
          normalizedRole === "super_agent" ||
          Boolean(assignedSuperAgentId);

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

  const bundlesByNetwork = useMemo(() => {
    const grouped = {};
    bundles.forEach((bundle) => {
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
    const transactionFee = getTransactionChargeAmount(
      baseAmount,
      paymentChargeSettings.superAgentPercent,
    );
    const grossAmount = Number((baseAmount + transactionFee).toFixed(2));
    const reference = `wallet_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const functionName = getEdgeFunctionName("verify-payment");

    try {
      console.log("[Purchase] Calling wallet edge function:", functionName);
      const { data, error } = await supabase.functions.invoke(functionName, {
        body: {
          wallet_order: true,
          reference,
          offer_id: bundle.id,
          package_name: bundle.name,
          package_size: bundle.dataSize || null,
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

      const providerResult = await dispatchProviderOrder(bundle, phone);
      if (providerResult.error || !providerResult.accepted) {
        showError(
          "Provider Order Failed",
          "Wallet debited, but the data provider did not accept the order.",
        );
        return;
      }

      const providerOrderId =
        providerResult.data?.payload?.orderId ||
        providerResult.data?.orderId ||
        providerResult.data?.payload?.orders?.[0]?.id ||
        null;
      const providerStatus =
        providerResult.data?.payload?.orders?.[0]?.status ||
        providerResult.data?.status ||
        "accepted";
      await supabase
        .from("orders")
        .update({
          jehuca_order_id: providerOrderId,
          jehuca_order_status: providerStatus,
          jehuca_response: providerResult.data || null,
        })
        .eq("id", data.order.id);

      showSuccess(
        "Purchase Successful!",
        `${bundle.name} was purchased from your wallet.`,
      );
      navigation.navigate("Receipt", {
        transaction: {
          id: data.order.id,
          status: data.order.status,
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

  const continueAgentPurchase = async () => {
    if (!recipientName.trim()) {
      showError("Recipient Name Required", "Please enter the recipient's name");
      return;
    }

    if (!recipientPhone.trim()) {
      showError(
        "Phone Number Required",
        "Please enter the recipient's phone number",
      );
      return;
    }

    const phoneRegex = /^(\+?233|0)?[2356789]\d{8}$/;
    const cleanPhone = recipientPhone.trim().replace(/\s+/g, "");
    if (!phoneRegex.test(cleanPhone)) {
      showError(
        "Invalid Phone Number",
        "Please enter a valid Ghana phone number (e.g., 0532973455 or +233532973455)",
      );
      return;
    }

    setRecipientModalVisible(false);
    if (isSuperAgentUser) {
      await handleSuperAgentWalletPurchase(selectedBundle, cleanPhone);
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
            Object.entries(bundlesByNetwork).map(
              ([networkName, networkBundles]) => (
                <View key={networkName} style={{ marginBottom: 20 }}>
                  {networkBundles.map((bundle) => (
                    <TouchableOpacity
                      key={bundle.id}
                      style={styles.bundleCard}
                      onPress={() => {
                        if (isAgent) {
                          handleAgentPurchase(bundle);
                        } else {
                          openNormalPurchase(bundle);
                        }
                      }}
                    >
                      <View style={styles.bundleCardContent}>
                        <View style={styles.bundleInfo}>
                          <View style={styles.bundleHeader}>
                            <View style={styles.networkBadge}>
                              <Text style={styles.networkBadgeText}>
                                {bundle.network}
                              </Text>
                            </View>
                            <Text style={styles.bundleType}>{bundle.type}</Text>
                          </View>
                          <View style={styles.bundleDetailsRow}>
                            <View style={styles.bundleDetail}>
                              <Text style={styles.bundleDetailLabel}>Data</Text>
                              <Text style={styles.bundleDetailValue}>
                                {bundle.dataSize}
                              </Text>
                            </View>
                            <View style={styles.bundleDetail}>
                              <Text style={styles.bundleDetailLabel}>
                                Bundle
                              </Text>
                              <Text style={styles.bundleDetailValue}>
                                {bundle.type}
                              </Text>
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
              ),
            )
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

      {!isAgent && selectedBundle && recipientModalVisible && (
        <Modal
          visible={recipientModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setRecipientModalVisible(false)}
        >
          <View style={styles.recipientModalOverlay}>
            <KeyboardAvoidingView
              style={styles.recipientModalAvoidingView}
              behavior="padding"
            >
              <View style={styles.recipientModalCard}>
                <View style={styles.recipientModalContent}>
                  <View style={styles.recipientModalHeader}>
                    <View>
                      <Text style={styles.recipientModalTitle}>
                        Who is this data for?
                      </Text>
                      <Text style={styles.recipientModalSubtitle}>
                        {selectedBundle.name}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => setRecipientModalVisible(false)}
                      style={styles.recipientModalClose}
                    >
                      <Ionicons
                        name="close"
                        size={22}
                        color={colors.secondary}
                      />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.purchaseTypeButtons}>
                    <TouchableOpacity
                      style={[
                        styles.purchaseTypeButton,
                        purchaseType === "self" &&
                          styles.purchaseTypeButtonActive,
                      ]}
                      onPress={() => setPurchaseType("self")}
                    >
                      <Ionicons
                        name="person"
                        size={18}
                        color={
                          purchaseType === "self"
                            ? colors.white
                            : colors.primary
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
                        purchaseType === "others" &&
                          styles.purchaseTypeButtonActive,
                      ]}
                      onPress={() => setPurchaseType("others")}
                    >
                      <Ionicons
                        name="people"
                        size={18}
                        color={
                          purchaseType === "others"
                            ? colors.white
                            : colors.primary
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

                  {purchaseType === "self" && (
                    <View style={styles.userPhoneContainer}>
                      <Ionicons
                        name="phone-portrait"
                        size={20}
                        color={colors.primary}
                      />
                      <Text style={styles.userPhoneText}>
                        Data will be sent to:{" "}
                        {userPhone || "your profile phone"}
                      </Text>
                    </View>
                  )}

                  {purchaseType === "others" && (
                    <>
                      <Text style={styles.phoneInputLabel}>
                        Recipient Phone Number
                      </Text>
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
                    </>
                  )}

                  <TouchableOpacity
                    style={styles.recipientContinueButton}
                    onPress={continueNormalPurchase}
                  >
                    <Text style={styles.recipientContinueText}>
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
          <View style={styles.recipientModalOverlay}>
            <KeyboardAvoidingView
              style={styles.recipientModalAvoidingView}
              behavior="padding"
            >
              <View style={styles.recipientModalCard}>
                <View style={styles.recipientModalContent}>
                  <View style={styles.recipientModalHeader}>
                    <View>
                      <Text style={styles.recipientModalTitle}>
                        Recipient Details
                      </Text>
                      <Text style={styles.recipientModalSubtitle}>
                        {selectedBundle.name}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => setRecipientModalVisible(false)}
                      style={styles.recipientModalClose}
                    >
                      <Ionicons
                        name="close"
                        size={22}
                        color={colors.secondary}
                      />
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.phoneInputLabel}>Recipient Name</Text>
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
                      autoFocus
                    />
                  </View>

                  <Text style={styles.phoneInputLabel}>Phone Number</Text>
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

                  <TouchableOpacity
                    style={styles.recipientContinueButton}
                    onPress={continueAgentPurchase}
                  >
                    <Text style={styles.recipientContinueText}>
                      Continue to Payment
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        </Modal>
      )}

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
                      color: colors.secondary,
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
                      color: colors.primary,
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
                  <View style={styles.paymentBreakdownRow}>
                    <Text style={styles.paymentBreakdownLabel}>
                      {isAgent && !isSuperAgentUser
                        ? "Package price"
                        : "Base data price"}
                    </Text>
                    <Text style={styles.paymentBreakdownValue}>
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
                  <View style={styles.paymentBreakdownRow}>
                    <Text style={styles.paymentBreakdownLabel}>
                      Transaction fee
                    </Text>
                    <Text style={styles.paymentBreakdownFee}>
                      GHS{" "}
                      {(
                        getAgentPaymentBreakdown()?.transactionFee || 0
                      ).toFixed(2)}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.paymentBreakdownRow,
                      styles.paymentBreakdownTotal,
                    ]}
                  >
                    <Text style={styles.paymentBreakdownTotalLabel}>
                      Total payment
                    </Text>
                    <Text style={styles.paymentBreakdownTotalValue}>
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
                      backgroundColor: "#f0faf5",
                      borderColor: "#b9e5ce",
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
                        color={colors.secondary}
                        style={{ marginRight: 7 }}
                      />
                      <Text
                        style={{
                          color: colors.secondary,
                          fontWeight: "700",
                          fontSize: 15,
                        }}
                      >
                        Payment will be sent to
                      </Text>
                    </View>
                    <Text
                      style={{
                        color: colors.dark,
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
                          color: colors.secondary,
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
                    console.log(
                      "[Purchase] Calling edge function:",
                      functionName,
                    );
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
                          recipient_name: isAgent ? recipientName.trim() : null,
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

                      const providerResult = await dispatchProviderOrder(
                        selectedBundle,
                        isAgent
                          ? recipientPhone
                          : purchaseType === "self"
                            ? userPhone
                            : recipientPhone,
                      );

                      if (providerResult.error || !providerResult.accepted) {
                        showError(
                          "Provider Order Failed",
                          "Payment was verified, but Jehucal did not accept the order. Contact support with the payment reference.",
                        );
                        return;
                      }

                      const providerOrderId =
                        providerResult.data?.payload?.orderId ||
                        providerResult.data?.orderId ||
                        providerResult.data?.payload?.orders?.[0]?.id ||
                        null;
                      await supabase
                        .from(data.is_agent_order ? "agent_orders" : "orders")
                        .update({
                          jehuca_order_id: providerOrderId,
                          jehuca_order_status:
                            providerResult.data?.payload?.orders?.[0]?.status ||
                            providerResult.data?.status ||
                            "accepted",
                          jehuca_response: providerResult.data || null,
                        })
                        .eq("id", data.order.id);
                      await supabase
                        .from("payment_transactions")
                        .update({
                          jehuca_order_id: providerOrderId,
                          jehuca_order_status:
                            providerResult.data?.payload?.orders?.[0]?.status ||
                            providerResult.data?.status ||
                            "accepted",
                          jehuca_response: providerResult.data || null,
                        })
                        .eq("payment_reference", data.order.payment_reference);

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
  paymentBreakdownRow: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  paymentBreakdownLabel: {
    color: colors.secondary,
    fontSize: 12,
  },
  paymentBreakdownValue: {
    color: colors.dark,
    fontSize: 12,
    fontWeight: "700",
  },
  paymentBreakdownFee: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "700",
  },
  paymentBreakdownTotal: {
    borderTopColor: colors.primary,
    marginTop: 2,
    paddingTop: 9,
  },
  paymentBreakdownTotalLabel: {
    color: colors.dark,
    fontSize: 13,
    fontWeight: "800",
  },
  paymentBreakdownTotalValue: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "900",
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
  recipientModalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  recipientModalAvoidingView: {
    width: "100%",
    maxHeight: "90%",
  },
  recipientModalCard: {
    overflow: "hidden",
    backgroundColor: colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  recipientModalContent: {
    padding: 24,
    paddingBottom: 32,
  },
  recipientModalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  recipientModalTitle: {
    color: colors.dark,
    fontSize: 20,
    fontWeight: "800",
  },
  recipientModalSubtitle: {
    color: colors.secondary,
    fontSize: 13,
    marginTop: 4,
  },
  recipientModalClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light,
  },
  recipientContinueButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    alignItems: "center",
    paddingVertical: 15,
    marginTop: 24,
  },
  recipientContinueText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "700",
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
