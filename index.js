import { registerRootComponent } from "expo";
import { Platform } from "react-native";

import App from "./App";
import { installWebInputReset } from "./src/components/ui";

// React Native Web renders every <TextInput> as a real <input>, so the browser
// paints its own focus outline over the themed field border. Removing it once
// here covers all 20+ inputs and any added later; the themed `fieldFocused`
// border remains as the focus affordance.
installWebInputReset();

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
