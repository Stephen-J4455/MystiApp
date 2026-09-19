import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import { PAYSTACK_PUBLIC_KEY } from "../lib/config";

export const usePaystackPayment = (config) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Load Paystack script dynamically (only on web)
  useEffect(() => {
    if (Platform.OS !== "web") {
      // On mobile, we'll use a different approach or WebView
      setIsLoaded(true);
      return;
    }

    if (typeof window === "undefined" || typeof document === "undefined") {
      console.log("Window or document not available");
      return;
    }

    // Check if Paystack is already loaded
    if (window.PaystackPop) {
      console.log("Paystack already loaded");
      setIsLoaded(true);
      return;
    }

    console.log("Loading Paystack script...");
    setIsLoading(true);

    // Load Paystack script
    const script = document.createElement("script");
    script.src = "https://js.paystack.co/v1/inline.js";
    script.async = true;
    script.onload = () => {
      console.log("Paystack script loaded successfully");
      setIsLoaded(true);
      setIsLoading(false);
    };
    script.onerror = (error) => {
      console.error("Failed to load Paystack script:", error);
      setIsLoaded(false);
      setIsLoading(false);
    };

    // Add to head
    document.head.appendChild(script);

    // Fallback timeout
    const timeout = setTimeout(() => {
      if (!isLoaded) {
        console.warn("Paystack script loading timeout");
        setIsLoading(false);
      }
    }, 10000);

    return () => {
      clearTimeout(timeout);
      // Cleanup script if component unmounts
      if (document.head && document.head.contains(script)) {
        document.head.removeChild(script);
      }
    };
  }, []);

  const initializePayment = useCallback(() => {
    if (!config) {
      console.error("Paystack config missing");
      return;
    }

    if (Platform.OS === "web") {
      // Web implementation
      console.log(
        "Web payment initialization - isLoaded:",
        isLoaded,
        "PaystackPop exists:",
        !!window.PaystackPop
      );

      if (!isLoaded) {
        console.log("Paystack script still loading, waiting...");
        // Wait for script to load
        const checkLoaded = setInterval(() => {
          if (window.PaystackPop && isLoaded) {
            clearInterval(checkLoaded);
            console.log("Paystack script loaded, proceeding with payment");
            initializePayment();
          }
        }, 100);

        // Timeout after 5 seconds
        setTimeout(() => {
          clearInterval(checkLoaded);
          console.error("Paystack script loading timeout");
        }, 5000);

        return;
      }

      if (!window.PaystackPop) {
        console.error("PaystackPop not available after loading");
        return;
      }

      try {
        console.log("Setting up Paystack payment with config:", {
          key: config.publicKey || PAYSTACK_PUBLIC_KEY,
          email: config.email,
          amount: config.amount,
          currency: config.currency || "GHS",
          ref: config.reference,
        });

        const handler = window.PaystackPop.setup({
          key: config.publicKey || PAYSTACK_PUBLIC_KEY,
          email: config.email,
          amount: config.amount,
          currency: config.currency || "GHS",
          ref:
            config.reference ||
            `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          metadata: config.metadata || {},
          callback: (response) => {
            console.log("Payment successful:", response);
            if (config.onSuccess) {
              config.onSuccess(response);
            }
          },
          onClose: () => {
            console.log("Payment cancelled");
            if (config.onClose) {
              config.onClose();
            }
          },
        });

        console.log("Opening Paystack iframe");
        handler.openIframe();
      } catch (error) {
        console.error("Error initializing Paystack payment on web:", error);
      }
    } else {
      // Mobile implementation - for now, just log that mobile payment needs different handling
      console.log("Mobile Paystack payment - needs WebView implementation");
      // This would need to be implemented with WebView or a native Paystack SDK
    }
  }, [isLoaded, config]);

  return { initializePayment, isLoaded, isLoading };
};
