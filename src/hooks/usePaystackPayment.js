import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";

const PAYSTACK_SCRIPT_URL = "https://js.paystack.co/v1/inline.js";
let paystackLoader;

const loadPaystack = () => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Web payment is unavailable"));
  }

  if (window.PaystackPop) return Promise.resolve(window.PaystackPop);
  if (paystackLoader) return paystackLoader;

  paystackLoader = new Promise((resolve, reject) => {
    const existingScript = document.querySelector(
      `script[src="${PAYSTACK_SCRIPT_URL}"]`,
    );
    const script = existingScript || document.createElement("script");
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    script.addEventListener(
      "load",
      () => {
        if (window.PaystackPop) {
          finish(resolve, window.PaystackPop);
        } else {
          finish(reject, new Error("Paystack loaded without PaystackPop"));
        }
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () =>
        finish(reject, new Error("Unable to load Paystack payment service")),
      { once: true },
    );

    if (!existingScript) {
      script.src = PAYSTACK_SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });

  paystackLoader.catch(() => {
    paystackLoader = undefined;
  });
  return paystackLoader;
};

export const usePaystackPayment = (config) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web") {
      setIsLoaded(true);
      return;
    }

    let active = true;
    setIsLoading(true);
    loadPaystack()
      .then(() => {
        if (active) setIsLoaded(true);
      })
      .catch((error) => {
        console.error("Failed to load Paystack script:", error);
        if (active) setIsLoaded(false);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const initializePayment = useCallback(async () => {
    if (!config) {
      throw new Error("Paystack config missing");
    }
    if (Platform.OS !== "web") return;

    if (!config.publicKey) {
      throw new Error("Paystack public key is unavailable");
    }

    const paystack = await loadPaystack();
    const setupOptions = {
      key: config.publicKey,
      email: config.email,
      amount: Number(config.amount),
      currency: config.currency || "GHS",
      ref: config.reference,
      metadata: config.metadata || {},
      callback: (response) => config.onSuccess?.(response),
      onClose: () => config.onClose?.(),
    };

    if (config.subaccount) {
      setupOptions.subaccount = config.subaccount;
      if (config.transactionCharge != null) {
        setupOptions.transaction_charge = config.transactionCharge;
      }
    }

    paystack.setup(setupOptions).openIframe();
  }, [config]);

  return { initializePayment, isLoaded, isLoading };
};
