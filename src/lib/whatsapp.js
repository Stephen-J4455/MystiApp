import { Linking } from "react-native";
export const ADMIN_WHATSAPP = "233501703777";
export const SUPPORT_WHATSAPP = "233501703777";

/**
 * Ghana's country code. Every number this app chats to is a local `0XX`/`XXX`
 * form or an already-international one, and the two are not interchangeable.
 */
const GHANA_CC = "233";

/**
 * Normalises a phone number to bare international digits for `wa.me`.
 *
 * `wa.me` redirects verbatim: it passes `0501703777` straight through as
 * `phone=0501703777`, which WhatsApp cannot match against an account, so the
 * chat never opens. The leading trunk `0` has to become the country code.
 *
 * Returns "" for anything without digits so callers can detect the problem
 * instead of deep-linking to `wa.me/?text=...`, which WhatsApp answers with a
 * generic page rather than a chat.
 */
export const toInternationalNumber = (number) => {
  const digits = String(number || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) return digits.slice(2);
  // A local Ghanaian number: 0XX -> 233XX.
  if (digits.length === 10 && digits.startsWith("0")) {
    return `${GHANA_CC}${digits.slice(1)}`;
  }
  return digits;
};

/**
 * Builds a click-to-chat URL.
 *
 * The message is percent-encoded here rather than by each caller. Hand-rolling
 * `?text=${encodeURIComponent(...)}` per screen is how the four order fields
 * (amount, reference, id) end up with unencoded newlines that truncate the
 * message at the first line break.
 *
 * The PHONE-NUMBER form is used deliberately. The `wa.me/message/<businessId>`
 * form silently DROPS `?text=` in its redirect, which opens the right chat with
 * an empty body - the entire complaint lost, with nothing to show for it.
 */
export const buildWhatsAppLink = (number, message) => {
  const phone = toInternationalNumber(number);
  if (!phone) {
    throw new Error("buildWhatsAppLink: a destination number is required");
  }
  return `https://wa.me/${phone}?text=${encodeURIComponent(String(message || ""))}`;
};

/**
 * Opens a WhatsApp chat.
 *
 * Returns a result rather than throwing. `Linking.openURL` to a `wa.me` URL
 * rejects whenever WhatsApp is not installed - on Android emulators, on
 * desktop, and on web - and the previous implementation swallowed that into a
 * `console.warn`, so a user tapping "Chat with admin" on a device without
 * WhatsApp saw NOTHING happen and no way to know why.
 *
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
export const openWhatsApp = async (number, message) => {
  const url = buildWhatsAppLink(number, message);

  try {
    const supported = await Linking.canOpenURL(url);
    if (supported === false) {
      return {
        ok: false,
        message: "WhatsApp is not available on this device.",
      };
    }
  } catch {
    // `canOpenURL` is best-effort. On Android it can reject for a scheme the
    // OS does not recognise even when `openURL` would still work, so a
    // rejection here is not treated as a failure.
  }

  try {
    await Linking.openURL(url);
    return { ok: true };
  } catch (error) {
    console.warn("Could not open WhatsApp:", error);
    return {
      ok: false,
      message:
        "Could not open WhatsApp. Make sure the app is installed and try again.",
    };
  }
};
