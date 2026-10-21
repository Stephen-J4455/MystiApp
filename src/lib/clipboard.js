// ===========================================================================
// Clipboard access, safely
// ===========================================================================
//
// WHY THIS IS NOT A PLAIN `import * as Clipboard from "expo-clipboard"`
// -------------------------------------------------------------------------
// `expo-clipboard` is a NATIVE module. Its JavaScript is bundled by Metro,
// but the native half lives in the compiled app. A device running an APK
// built before the dependency was installed has the JavaScript and not the
// native code, and the module THROWS AT IMPORT TIME:
//
//     Uncaught Error: Cannot find native module 'ExpoClipboard'
//
// Because that happens while the module graph is being evaluated, it is not
// catchable at the call site - the whole screen fails to load, and the user
// sees a red screen instead of the feature.
//
// So the module is resolved LAZILY, inside the function, and the failure is
// caught. The screen loads, the copy button reports "copying is not available
// on this build" instead of crashing the app, and a rebuild makes it work.
//
// The rebuild is still the right answer - this only stops a stale build from
// taking the whole screen down with it.
//
// HOW TO ACTUALLY GET THE NATIVE CODE
// ----------------------------------
// Adding a native dependency to an Expo app requires a new native build. A
// Metro reload is not enough:
//
//     npm run android:dev     # rebuilds the APK against the -test functions
//     npm run android:prod    # rebuilds against production
//
// A new build is needed for EVERY native dependency, forever. This is not a
// quirk of this project - it is how React Native works.
//
// WHY THE SHARED ADMIN APP IS NOT AFFECTED
// -----------------------------------------
// `MystiAdminApp` has used `expo-clipboard` for its phone-number copy
// buttons for a long time, so its APK has contained the native module for
// just as long. Only the customer app needed this.
//
// The result is a boolean rather than a thrown error, because the CALLER has
// to decide what to do about it - a toast saying "copying is not available"
// and a silent failure are different user experiences, and only the caller
// knows which one is right.

let cachedModule;
let attempted = false;

const getClipboard = () => {
  if (attempted) return cachedModule;
  attempted = true;
  try {
    // Resolved at CALL time, not at import time. This is the whole point.
    cachedModule = require("expo-clipboard");
  } catch (error) {
    console.warn(
      "[clipboard] expo-clipboard is unavailable in this build. The native " +
        "module is missing, which means the app needs a new native build " +
        "(npm run android:dev). Copying will be unavailable until then.",
      error,
    );
    cachedModule = null;
  }
  return cachedModule;
};

/**
 * Copy text to the clipboard.
 *
 * @param {string} text
 * @returns {Promise<boolean>} true when the text was copied, false when it
 *   could not be - either because the native module is missing from this
 *   build, or because the platform refused the write.
 */
export const copyToClipboard = async (text) => {
  const clipboard = getClipboard();
  if (!clipboard || typeof clipboard.setStringAsync !== "function") {
    return false;
  }
  try {
    await clipboard.setStringAsync(String(text ?? ""));
    return true;
  } catch (error) {
    console.error("[clipboard] Could not write to the clipboard:", error);
    return false;
  }
};

/**
 * Whether the clipboard is usable in this build.
 *
 * Lets a screen hide or disable a copy control rather than offering a button
 * that silently does nothing.
 */
export const isClipboardAvailable = () => Boolean(getClipboard());
