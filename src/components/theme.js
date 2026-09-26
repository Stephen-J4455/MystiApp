const colors = {
  primary: "#006769",
  secondary: "#2B5F1F",
  accent: "#40A578",
  tint: "#e6edf1ff",
  light: "#f7f9faff",
  white: "#ffffffff",
  dark: "#1A1A1A",
  border: "#D1D9E0",
  success: "#27ae60",
  danger: "#e74c3c",
  warning: "#f39c12",
};

// Home screen design tokens. The home page runs a dark "console" canvas with a
// single luminous hero, so it needs its own surface ramp that the legacy
// light-mode screens (which read `colors.primary` etc.) can keep using.
const home = {
  // Canvas, darkest at the top of the scroll where the hero sits.
  canvas: "#04100F",
  canvasRaised: "#08201D",
  surface: "#0D2A26",
  surfaceHover: "#123833",
  hairline: "rgba(120, 226, 199, 0.14)",
  hairlineStrong: "rgba(120, 226, 199, 0.28)",

  // Hero gradient: deep forest -> teal, with a mint highlight.
  heroFrom: "#0B3B33",
  heroVia: "#075A52",
  heroTo: "#00A88F",
  heroGlow: "rgba(64, 245, 200, 0.35)",

  textPrimary: "#F2FBF8",
  textSecondary: "rgba(226, 245, 240, 0.72)",
  textMuted: "rgba(226, 245, 240, 0.46)",

  mint: "#5CF0C8",
  mintDim: "#2BB79A",
  amber: "#F5C451",
  rose: "#FF7A6B",
  sky: "#6FC8F5",
};

// Carrier brand colours, used for the network cards on the home screen.
// Mostly literal brand values, lifted where noted: MTN's #FFCC00 is exact,
// while Telecel's and AirtelTigo's are brightened from #E4002B and #0071BC.
// They sit on a near-black scrim, where the darker corporate values go muddy,
// and each accent also becomes a fill behind a dark (#04231F) arrow glyph,
// which needs a light background to stay legible.
const networks = {
  mtn: "#FFCC00", // yellow
  telecel: "#FF4D4D", // red
  airteltigo: "#4DA3FF", // blue
};

// Fraunces for display/headline moments, Public Sans for everything else.
const fonts = {
  display: "Fraunces_600SemiBold",
  displayBold: "Fraunces_700Bold",
  body: "PublicSans_400Regular",
  bodyMedium: "PublicSans_500Medium",
  bodySemi: "PublicSans_600SemiBold",
  bodyBold: "PublicSans_700Bold",
  bodyBlack: "PublicSans_800ExtraBold",
};

// ---------------------------------------------------------------------------
// Light / dark palettes
//
// `getPalette(scheme)` returns a single flat object that every screen reads via
// `useTheme()`. Screens must NOT branch on the scheme themselves - they pick a
// token and get the right value. That is what keeps a 24-screen app tractable.
//
// Dark is derived from the original `home` console palette so the existing
// Home screen keeps its exact look while light mode is a new variant.
// ---------------------------------------------------------------------------
const light = {
  // Surfaces, lightest to darkest.
  canvas: "#F4F8F7",
  canvasRaised: "#FFFFFF",
  surface: "#FFFFFF",
  surfaceHover: "#EDF3F2",
  surfaceSunken: "#E6EDEC",

  hairline: "rgba(0, 103, 105, 0.12)",
  hairlineStrong: "rgba(0, 103, 105, 0.24)",

  // Hero gradient. Inverted relative to dark: light->deeper, so white text
  // on the hero still holds contrast at the top of the card.
  heroFrom: "#00A88F",
  heroVia: "#007D7F",
  heroTo: "#00595B",
  heroGlow: "rgba(0, 168, 143, 0.18)",
  heroText: "#FFFFFF",
  heroTextDim: "rgba(255, 255, 255, 0.78)",

  textPrimary: "#0B1F1E",
  textSecondary: "rgba(11, 31, 30, 0.68)",
  textMuted: "rgba(11, 31, 30, 0.44)",
  textInverse: "#FFFFFF",

  // Accents. Light mode needs deeper values than dark mode to hit the same
  // perceived contrast against a pale background - the dark-mode set is
  // tuned to glow on near-black and would be far too weak on white.
  mint: "#00876F",
  mintDim: "#00A88F",
  amber: "#A96A00",
  rose: "#C2352A",
  sky: "#0B6FA4",
  onAccent: "#FFFFFF", // glyph colour when placed on mint/sky fills

  shadow: "rgba(6, 32, 30, 0.10)",
  skeleton: "#E3EBEA",
  scrim: "rgba(4, 16, 15, 0.55)", // overlay over images in light mode
  // Ad imagery is arbitrary user-supplied art with no guaranteed brightness,
  // so its overlay stays dark in BOTH schemes - flipping it would risk white
  // text on a pale ad. Only the network cards, whose images we control, use
  // the scheme-aware `scrim`.
  adScrim: "rgba(4, 16, 15, 0.88)",
  tabBar: "rgba(255, 255, 255, 0.94)",
  menuBackdrop: "rgba(6, 26, 25, 0.32)",
  badgeOnAccent: "#3A0A05",
};

const dark = {
  canvas: "#04100F",
  canvasRaised: "#08201D",
  surface: "#0D2A26",
  surfaceHover: "#123833",
  surfaceSunken: "#031010",

  hairline: "rgba(120, 226, 199, 0.14)",
  hairlineStrong: "rgba(120, 226, 199, 0.28)",

  heroFrom: "#0B3B33",
  heroVia: "#075A52",
  heroTo: "#00A88F",
  heroGlow: "rgba(64, 245, 200, 0.35)",
  heroText: "#FFFFFF",
  heroTextDim: "rgba(226, 245, 240, 0.72)",

  textPrimary: "#F2FBF8",
  textSecondary: "rgba(226, 245, 240, 0.72)",
  textMuted: "rgba(226, 245, 240, 0.46)",
  textInverse: "#0B1F1E",

  mint: "#5CF0C8",
  mintDim: "#2BB79A",
  amber: "#F5C451",
  rose: "#FF7A6B",
  sky: "#6FC8F5",
  onAccent: "#04231F",

  shadow: "rgba(0, 0, 0, 0.40)",
  skeleton: "#123833",
  scrim: "rgba(4, 16, 15, 0.62)",
  adScrim: "rgba(4, 16, 15, 0.88)",
  tabBar: "rgba(4, 16, 15, 0.94)",
  menuBackdrop: "rgba(2, 10, 9, 0.72)",
  badgeOnAccent: "#1A0500",
};

const getPalette = (scheme) => (scheme === "light" ? light : dark);

// Status pill colours, per mode. `tone` picks a family so call sites can share
// one helper instead of duplicating switches per screen.
const getStatusTone = (scheme) => {
  const t = getPalette(scheme);
  const mix = (hex, alpha) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };
  return {
    completed: { label: "Completed", color: t.mint, bg: mix(t.mint, 0.12) },
    processing: { label: "Processing", color: t.sky, bg: mix(t.sky, 0.12) },
    pending: { label: "Pending", color: t.amber, bg: mix(t.amber, 0.12) },
    // Cancelled shares the red "this order is dead" signal with failed, but
    // keeps its own label so the two stay distinguishable.
    cancelled: { label: "Cancelled", color: t.rose, bg: mix(t.rose, 0.12) },
    failed: { label: "Failed", color: t.rose, bg: mix(t.rose, 0.12) },
    refunded: { label: "Refunded", color: t.sky, bg: mix(t.sky, 0.12) },
  };
};

export default colors;
export {
  colors,
  home,
  fonts,
  networks,
  light,
  dark,
  getPalette,
  getStatusTone,
};
