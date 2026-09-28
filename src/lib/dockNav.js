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

/**
 * Everything in the centre "More" popup, in display order.
 *
 * `requires` gates an item by account type. Omitted means "everyone".
 *
 *   superAgent : Super Agent only (any badge)
 *   enterprise : Enterprise badge only - the same rule the web overflow drawer
 *                in `HomeScreen.js` applies to its `menuItems`, and the same
 *                rule each gated screen enforces on mount. Pro Super Agents
 *                do not get these; the screens themselves bounce them back to
 *                Home with "Enterprise access", so exposing the entry in the
 *                dock just produced a dead tap that looked like the dock
 *                "reopening" the previous screen.
 *   wallet     : anyone who OWNS a `super_agent_wallets` row, whatever their
 *                role. See the note on the Wallet entry below.
 */
export const MORE_ITEMS = [
  {
    routeName: "WalletTopUp",
    label: "Wallet",
    caption: "Top up balance",
    icon: "wallet-outline",
    activeIcon: "wallet",
    // Gated on OWNERSHIP, not on role.
    //
    // A sub-agent demoted from Super Agent keeps their `super_agent_wallets`
    // row - that table is keyed on `super_agent_id` and its RLS is
    // `super_agent_id = auth.uid()` with no role term, so the balance is still
    // theirs to read. Nothing deletes the row on a role change, which is the
    // whole point: they earned it.
    //
    // This entry used to be `superAgent`, which hid the balance from exactly
    // the people who still had money sitting in it. `WalletTopUpScreen` now
    // shows those accounts a READ-ONLY view and blocks funding with
    // "Top-up unavailable", so this is not a dead tap - it is the one place
    // they can see the balance.
    //
    // `moreItemsFor` resolves this against the `ownsWallet` flag the caller
    // passes, which comes from actually reading the wallet row.
    requires: "wallet",
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
    requires: "enterprise",
  },
  {
    routeName: "SuperAgentOffers",
    label: "Offers",
    caption: "Promo plans",
    icon: "pricetags-outline",
    activeIcon: "pricetags",
    requires: "enterprise",
  },
  {
    routeName: "SuperAgentTierManagement",
    label: "Tiers",
    caption: "Level rules",
    icon: "layers-outline",
    activeIcon: "layers",
    requires: "enterprise",
  },
  {
    routeName: "SuperAgentAnalytics",
    label: "Insights",
    caption: "Business trends",
    icon: "stats-chart-outline",
    activeIcon: "stats-chart",
    requires: "superAgent",
  },
  {
    routeName: "SuperAgentPaystack",
    label: "Paystack",
    caption: "Sub-account",
    icon: "card-outline",
    activeIcon: "card",
    requires: "enterprise",
  },
  {
    routeName: "PrivacyPolicy",
    label: "Privacy",
    caption: "Terms & policy",
    icon: "document-text-outline",
    activeIcon: "document-text",
  },
];

/**
 * Narrow `MORE_ITEMS` to what this account may actually open.
 *
 * Mirrors the drawer rules in `HomeScreen.js`:
 *   - Enterprise Super Agent: the full suite.
 *   - Pro Super Agent:        Insights, Wallet, plus the universal items. No
 *                             Tiers, Offers, Agents or Paystack.
 *   - Sub-agent who was
 *     demoted from Super
 *     Agent and still owns a
 *     wallet row:             Wallet (read-only), plus the universal items.
 *   - Sub-agent (current or
 *     mirrored):             Wallet, plus the universal items.
 *   - Normal user:            Alerts, AFA and Privacy only. NO Wallet. They
 *                             have no wallet and cannot acquire one - see the
 *                             explicit denial in `moreItemsFor`.
 *
 * `isSuperAgent` here is the ACCOUNT TYPE, not the badge - a Pro Super Agent
 * still owns sub-agents, wallet and analytics, just not the management suite.
 *
 * `isNormalUser` is a separate input and the Wallet entry treats it as a VETO,
 * not as another way of qualifying. That asymmetry is the point: "is a super
 * agent" and "owns a wallet row" are both ways of EARNING the entry, while
 * "is a normal user" is a reason to REFUSE it regardless of either. A sub
 * agent and a normal user are both non-super-agents, but only one of them may
 * see a wallet, so the gate cannot be phrased as a positive test.
 *
 * `ownsWallet` is deliberately a separate input rather than being derived from
 * `isSuperAgent`. Ownership of a `super_agent_wallets` row is a property of
 * the DATA, not of the role: a demoted ex-super-agent has the row and the
 * role, and a promoted super agent may have no row yet. Only the caller knows
 * the answer, because it is the caller that reads the row.
 */
export const moreItemsFor = ({
  isSuperAgent = false,
  isEnterprise = false,
  ownsWallet = false,
  isNormalUser = false,
} = {}) =>
  MORE_ITEMS.filter((item) => {
    if (item.requires === "enterprise") {
      return Boolean(isSuperAgent) && Boolean(isEnterprise);
    }
    if (item.requires === "superAgent") return Boolean(isSuperAgent);
    // Ownership OR role: a current super agent always keeps the entry, even
    // before their wallet row exists, so the top-up flow can create it.
    //
    // A NORMAL USER IS EXPLICITLY DENIED, not merely excluded by omission.
    // A normal user has no wallet and cannot acquire one - `verify-wallet-topup`
    // refuses the payment because `identity.superAgentId` is null - so any row
    // that somehow exists is not theirs to see. Without the explicit denial,
    // a normal user who was ever mis-seeded with a `super_agent_wallets` row
    // (by a demotion, a bad backfill, or a manual fix) would be shown a
    // wallet entry and a balance for money they cannot spend or withdraw.
    if (item.requires === "wallet") {
      if (isNormalUser) return false;
      return Boolean(isSuperAgent) || Boolean(ownsWallet);
    }
    return true;
  });

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
