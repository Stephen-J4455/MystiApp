// ===========================================================================
// Ghana phone number input
// ===========================================================================
// WHY THIS IS SHARED
// -------------------
// The same logic was inlined in four places, and it had drifted:
//   - `DataScreen`      - two TextInputs + two `phoneRegex` literals
//   - `AfaRegistrationScreen`
//   - `ProfileScreen`
//   - `SuperAgentAgentsScreen`
//
// Worse, each copy sanitised differently. Some stripped whitespace and some
// did not, so a pasted "0532 973 455" validated on one screen and failed on
// another. One implementation removes the possibility of that drift.
//
// THE 10-DIGIT LIMIT, AND WHY IT IS NOT SIMPLY `maxLength={10}`
// -------------------------------------------------------------
// Ghana numbers have two common shapes and they are different LENGTHS:
//
//   0532 973 455   -> 10 digits, the local / 0-prefixed form
//   +233 532 973455 -> 12 digits plus a "+", the international form
//
// A raw `maxLength={10}` would truncate the international form at
// "+233532973" - silently producing a valid-looking but WRONG number, which
// then goes to the data provider. That is worse than rejecting it, because
// the order is accepted and the data never arrives.
//
// So the international prefix is folded to `0` as the user types, and only
// then is the 10-digit cap applied. `+233532973455` and `233532973455` both
// collapse to `0532973455`, which is what the provider is given.
//
// KEYBOARD IS NOT A FILTER
// -------------------------
// `keyboardType="phone-pad"` is a HINT, not a constraint. It still accepts
// pasted text, and on Android it varies by keyboard and locale. The sanitising
// below is what actually enforces the rule; the keyboard is only there to
// make the right keys easy to reach.

// 10 digits: a leading 0, then a network digit in [2356789], then 8 more.
// The second digit is restricted deliberately - 0, 1 and 4 are not valid
// Ghana mobile prefixes, so catching it at the input is friendlier than
// letting the user type all 10 and failing on submit.
export const GHANA_PHONE_REGEX = /^0[2356789]\d{8}$/;

// The longest a Ghana number can be once written as a bare digit string:
// 12 for "233XXXXXXXXX".
const MAX_RAW_DIGITS = 12;

/**
 * Folds an international Ghana prefix to the local `0` form, then caps at 10
 * digits and drops everything that is not a digit.
 *
 * Non-digits are dropped rather than rejected, so a pasted
 * "0532 973 455" or "(+233) 532-973455" sanitises to something usable
 * instead of failing wholesale. The caller's own `keyboardType` still
 * prevents most of those keys from being typed at all.
 *
 * @param {string} raw text straight from the TextInput
 * @returns {string} a 10-digit local number, or a shorter prefix of one
 */
export const sanitizeGhanaPhone = (raw) => {
  if (typeof raw !== "string") return "";

  // Drop everything that is not a digit. The plus is only inspected to decide
  // whether the digits that follow are a country code - it carries no digit of
  // its own, and a "+" appearing mid-string is simply removed.
  const hasLeadingPlus = raw.trim().startsWith("+");
  let digits = raw.replace(/\D/g, "");

  if (digits.length > MAX_RAW_DIGITS) {
    digits = digits.slice(0, MAX_RAW_DIGITS);
  }

  // Strip a leading 233 country code, then RESTORE the local 0 prefix.
  //
  // The restore is the part that is easy to get wrong, and getting it wrong
  // silently BREAKS a valid number: slicing "233" off "233532973455" leaves
  // "532973455" - nine digits, no longer a Ghana number. So the international
  // form would turn into an INVALID one, which is worse than rejecting it,
  // because the result still looks like a phone number and would be sent to
  // the data provider.
  if (digits.startsWith("233") && (hasLeadingPlus || digits.length > 10)) {
    digits = `0${digits.slice(3)}`;
  }

  return digits.slice(0, 10);
};

/**
 * True when `phone` is a complete, valid Ghana number in local form.
 *
 * Used for the submit-time guard, so an incomplete number ("0532") is
 * reported rather than sent to the provider.
 */
export const isValidGhanaPhone = (phone) => {
  const sanitized = sanitizeGhanaPhone(phone);
  return GHANA_PHONE_REGEX.test(sanitized);
};

/**
 * A short, concrete explanation of what is wrong with `phone`, or null when
 * it is valid.
 *
 * Distinguishes "too short" from "bad second digit" because they have
 * different fixes, and a user who has typed 4 digits does not need to be told
 * the format is invalid before they have finished.
 */
export const getGhanaPhoneError = (phone) => {
  const digits = sanitizeGhanaPhone(phone);

  if (!digits) {
    return "Please enter a phone number";
  }
  if (digits.length < 10) {
    return "Enter all 10 digits (e.g., 0532973455)";
  }
  if (digits[0] !== "0") {
    return "Ghana numbers start with 0 (e.g., 0532973455)";
  }
  if (!/[2356789]/.test(digits[1] || "")) {
    return "That is not a valid Ghana network prefix (e.g., 0532973455)";
  }
  return null;
};
