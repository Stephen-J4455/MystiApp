import { registerRootComponent } from "expo";
import { Platform } from "react-native";

import App from "./App";

registerRootComponent(App);

// Register only for the production web build. The worker uses a network-first
// shell strategy and explicitly excludes Supabase, API and authenticated data.
if (Platform.OS === "web" && process.env.NODE_ENV === "production") {
  window.addEventListener("load", () => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {
        // PWA installation can still work when worker registration is blocked.
      });
    }
  });
}
