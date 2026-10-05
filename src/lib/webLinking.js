/**
 * Web-only `linking` config for the `NavigationContainer` in `App.js`.
 *
 * ## Why this file exists
 *
 * The web build had NO `linking` prop. React Navigation therefore did not
 * subscribe to `popstate`, so pressing the browser Back button changed the URL
 * (or, on a single-entry history, did nothing visible) but never issued a `GO_BACK`
 * action. The stack kept the screen underneath, and the user was stuck: the only
 * way out of a pushed screen was its in-app back chevron.
 *
 * `linking` is what wires the two together. With it set, every `navigate` pushes
 * a real history entry, and Back pops the stack.
 *
 * ## Why it is gated to web
 *
 * The native build already has its own `Linking` handling in `App.js` for the
 * password-recovery deep link (`mystiwanebusiness://...`). Installing a second
 * linking config on native would give the container its own URL listener and
 * fight that one for the same events. So this config is passed only when
 * `Platform.OS === "web"`.
 *
 * ## Params are stripped on purpose
 *
 * `filter` drops every param from the URL. That is not laziness, it is
 * required: `ReceiptScreen` is reached with `route.params.transaction`, a whole
 * object holding a transaction row. `getPathFromState` would try to serialise it
 * into the query string, producing a URL that is unreadable, over-long, and -
 * because a reloaded page would then have to re-fetch that row - not even
 * restorable. No screen in this app reads a param back out of the URL, so the
 * honest URL is the bare route name and nothing else.
 */

/** Auth routes, which are the only ones registered while signed out. */
const AUTH_ROUTES = ["Login", "Signup", "ForgotPassword", "ResetPassword"];

/** Signed-in routes, mirroring the signed-in branch of `Stack.Navigator`. */
const APP_ROUTES = [
  "Home",
  "Profile",
  "PrivacyPolicy",
  "Notifications",
  "Data",
  "SuperAgentManagement",
  "SuperAgentOffers",
  "SuperAgentTierManagement",
  "SuperAgentAgents",
  "SuperAgentPaystack",
  "SuperAgentAnalytics",
  "SuperAgentHeldOrders",
    "SuperAgentTransactions",
    "SuperAgentLedger",
  "Receipt",
  "History",
  "WalletTopUp",
  "AfaRegistration",
];

/**
 * The deepest route in a navigation state, i.e. the currently focused screen.
 *
 * A stack state nests one level per navigator, so the leaf is found by walking
 * `state.routes[state.index]` downwards. Returning the leaf NAME (rather than
 * building a nested path) is what keeps params out of the URL - a stack's
 * default serialisation would encode every screen in it.
 */
const currentRouteName = (state) => {
  let route = state?.routes?.[state.index];
  while (route?.state) {
    route = route.state.routes?.[route.state.index];
  }
  return route?.name ?? null;
};

/**
 * Builds the linking config.
 *
 * @param {boolean} isSignedIn  Which branch of the navigator is mounted. Only
 *   routes in that branch can be resolved, so a URL naming a route from the
 *   other branch has to be discarded or React Navigation boots into a state
 *   where the URL and the stack disagree.
 */
export const getWebLinking = (isSignedIn) => {
  const allowed = isSignedIn ? APP_ROUTES : AUTH_ROUTES;

  return {
    /**
     * The origin is the prefix, so the browser gets real paths
     * (`https://mysti.example/Profile`) rather than a hash the service worker
     * and the Vercel rewrite would both have to be taught about.
     */
    prefix:
      typeof window !== "undefined" && window.location
        ? window.location.origin
        : "/",

    /**
     * Reject URLs pointing at a route the current navigator does not have.
     * Two cases this actually prevents:
     *
     *   - Signed out, someone reloads a deep link to `/Profile`. Without the
     *     filter the container tries to honour it, no such screen is registered,
     *     and the app renders a broken state instead of Login.
     *   - Signed out at `/ForgotPassword`, the user signs in: `user` flips and
     *     the navigator re-renders with the app routes only, but the URL still
     *     says `/ForgotPassword`. The filter keeps the two consistent.
     *
     * Matching on the first path segment is enough - route names are flat, and
     * a hand-typed `?query` must not affect the decision.
     */
    filter: (url) => {
      const [, first = ""] = url.split("?")[0].split("/").filter(Boolean);
      return allowed.includes(first);
    },

    /** Route name only. No query string - see the file header. */
    getPathFromState: (state) => {
      const name = currentRouteName(state);
      return name && allowed.includes(name) ? `/${name}` : "/";
    },

    /** Inverse of the above, and equally param-free. */
    getStateFromPath: (path) => {
      const name = path.split("?")[0].split("/").filter(Boolean)[0];
      if (!name || !allowed.includes(name)) return undefined;
      // Params are deliberately absent: a bare `{ routes: [{ name }] }` state
      // is exactly what `filter`/`getStateFromPath` produce for a param-free
      // route, and `ReceiptScreen` degrades gracefully with no params.
      return { routes: [{ name }] };
    },
  };
};
