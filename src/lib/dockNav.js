/**
 * Dock navigation config for the main (Mysti) app.
 *
 * The four primary tabs are the app's real sections; everything else is
 * reachable from the centre "More" popup. Route names must match the
 * `Stack.Screen` names registered in `App.js`, because the dock navigates by
 * name through `navigationRef`.
 */

export const DOCK_BAR_HEIGHT = 64;

// Total vertical space the dock occupies at the bottom of the screen, safe-area
// inset included. Screens add this as bottom padding so their last row is never
// parked underneath the bar.
export const dockInsetHeight = (bottomInset) =>
  DOCK_BAR_HEIGHT + (bottomInset || 0);

/**
 * Shared style for the dock. Exported so a screen that temporarily hides the
 * dock (or a host that renders it) can restore the exact same geometry.
 */
export const DOCK_TAB_BAR_STYLE = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  height: DOCK_BAR_HEIGHT,
};

/** The four primary destinations, in dock order (left pair, then right pair). */
export const PRIMARY_TABS = [
  {
    routeName: "Home",
    label: "Home",
    icon: "home-outline",
    activeIcon: "home",
  },
  {
    routeName: "Data",
    label: "Data",
    icon: "cellular-outline",
    activeIcon: "cellular",
  },
  {
    routeName: "History",
    label: "History",
    icon: "receipt-outline",
    activeIcon: "receipt",
  },
  {
    routeName: "Profile",
    label: "Profile",
    icon: "person-outline",
    activeIcon: "person",
  },
];

/** Everything in the centre "More" popup, in display order. */
export const MORE_ITEMS = [
  {
    routeName: "WalletTopUp",
    label: "Wallet",
    caption: "Top up balance",
    icon: "wallet-outline",
    activeIcon: "wallet",
  },
  {
    routeName: "Notifications",
    label: "Alerts",
    caption: "Push history",
    icon: "notifications-outline",
    activeIcon: "notifications",
  },
  {
    routeName: "AfaRegistration",
    label: "AFA",
    caption: "Agent sign-ups",
    icon: "shield-checkmark-outline",
    activeIcon: "shield-checkmark",
  },
  {
    routeName: "SuperAgentManagement",
    label: "Agents",
    caption: "Sub-agents",
    icon: "people-outline",
    activeIcon: "people",
  },
  {
    routeName: "SuperAgentOffers",
    label: "Offers",
    caption: "Promo plans",
    icon: "pricetags-outline",
    activeIcon: "pricetags",
  },
  {
    routeName: "SuperAgentTierManagement",
    label: "Tiers",
    caption: "Level rules",
    icon: "layers-outline",
    activeIcon: "layers",
  },
  {
    routeName: "SuperAgentAnalytics",
    label: "Insights",
    caption: "Business trends",
    icon: "stats-chart-outline",
    activeIcon: "stats-chart",
  },
  {
    routeName: "SuperAgentPaystack",
    label: "Paystack",
    caption: "Sub-account",
    icon: "card-outline",
    activeIcon: "card",
  },
  {
    routeName: "PrivacyPolicy",
    label: "Privacy",
    caption: "Terms & policy",
    icon: "document-text-outline",
    activeIcon: "document-text",
  },
];

/** Route names the dock considers "the More section", for active-state tinting. */
export const MORE_ROUTE_NAMES = MORE_ITEMS.map((item) => item.routeName);

/**
 * Routes that must never show the bottom dock.
 *
 * The dock is mounted once in `App.js`, above the navigator, so by default it
 * draws on EVERY screen - including the ones a signed-out visitor can reach.
 * Before this list existed, Login / Signup / ForgotPassword rendered with the
 * full four-tab bar and a "More" popup over the form, on a screen whose entire
 * purpose is to get the user past authentication.
 *
 * Kept here, beside the route names the dock already knows, rather than
 * inlined at the call site: this file is the single place that enumerates
 * dock-visible routes, so a new auth screen is added in one spot.
 *
 * MUST stay in step with the signed-out branch of the `Stack.Navigator` in
 * `App.js` - a screen registered there but missing from this list renders with
 * the dock over it. `ResetPassword` is in that branch and is easy to overlook
 * because it is reachable from a deep link rather than from a button.
 */
export const AUTH_ROUTE_NAMES = [
  "Login",
  "Signup",
  "ForgotPassword",
  "ResetPassword",
];

/** True when `routeName` should render without the bottom dock. */
export const isAuthRoute = (routeName) =>
  AUTH_ROUTE_NAMES.includes(String(routeName || ""));
