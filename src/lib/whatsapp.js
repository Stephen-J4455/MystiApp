import { Linking } from "react-native";
export const ADMIN_WHATSAPP = "233532973455";
export const SUPPORT_WHATSAPP = "233532973455";

/**
 * Builds a click-to-chat URL.
 *
 * The message is percent-encoded here rather than by each caller. Hand-rolling
 * `?text=${encodeURIComponent(...)}` per screen is how the four order fields
 * (amount, reference, id) end up with unencoded newlines that truncate the
 * message at the first line break.
 */
export const buildWhatsAppLink = (number, message) =>
  `https://wa.me/message/45GU7PROOYDFE1?text=${encodeURIComponent(String(message || ""))}`;

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
