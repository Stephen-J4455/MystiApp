import { supabase } from "./supabase.js";
import { getEdgeFunctionName } from "./env.js";

/**
 * Invokes a Supabase edge function with the correct function name.
 * All logging is handled globally by the supabase.functions.invoke
 * patch in src/lib/supabase.js, which ensures every edge function
 * call logs its endpoint name exactly once.
 *
 * @param {string} name - Raw edge function name (e.g. "get-packages")
 * @param {object} [options] - Options passed to supabase.functions.invoke
 * @returns {Promise<{data: any, error: any}>}
 */
export const invokeEdgeFunction = async (name, options = {}) => {
  const functionName = getEdgeFunctionName(name);
  return supabase.functions.invoke(functionName, options);
};

/**
 * Invokes a Supabase edge function by its resolved endpoint name.
 * All logging is handled globally by the supabase.functions.invoke
 * patch in src/lib/supabase.js.
 *
 * @param {string} functionName - The resolved edge function name (e.g. "paystack-subaccount-test")
 * @param {object} [options] - Options passed to supabase.functions.invoke
 * @returns {Promise<{data: any, error: any}>}
 */
export const invokeEdgeFunctionByName = async (functionName, options = {}) => {
  return supabase.functions.invoke(functionName, options);
};

/**
 * Extracts the JSON error returned by a non-2xx Edge Function response.
 * Supabase stores the original Response on FunctionsHttpError.context.
 */
export const getEdgeFunctionErrorMessage = async (error, fallback) => {
  const response = error?.context || error?.response;
  let payload = null;

  if (response?.clone) {
    try {
      payload = await response.clone().json();
    } catch (_error) {
      try {
        const text = await response.clone().text();
        payload = text ? { error: text } : null;
      } catch (_textError) {
        payload = null;
      }
    }
  } else if (error && typeof error === "object") {
    payload = error;
  }

  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  return (
    payload?.error ||
    payload?.message ||
    error?.message ||
    fallback ||
    "The Edge Function request failed."
  );
};
