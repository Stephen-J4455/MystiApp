import { supabase } from "./supabase";

export const DEFAULT_PAYMENT_SETTINGS = {
  normalUserPercent: 1.95,
  superAgentPercent: 1.95,
  walletTopUpPercent: 1.95,
};

export const fetchPaymentChargeSettings = async () => {
  const { data, error } = await supabase
    .from("payment_charge_settings")
    .select("*")
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw error;
  }

  const values = data || {};
  return {
    normalUserPercent: Number(values.normal_user_percent ?? 1.95),
    superAgentPercent: Number(values.super_agent_percent ?? 1.95),
    walletTopUpPercent: Number(values.wallet_topup_percent ?? 1.95),
  };
};

export const getTransactionChargeAmount = (amount, percentage) => {
  const numericAmount = Number(amount || 0);
  const numericPercent = Number(percentage || 0);
  return Number(((numericAmount * numericPercent) / 100).toFixed(2));
};

export const getEffectiveAmountForPayment = (baseAmount, percentage) => {
  const numericBase = Number(baseAmount || 0);
  const fee = getTransactionChargeAmount(numericBase, percentage);
  return Number((numericBase + fee).toFixed(2));
};
