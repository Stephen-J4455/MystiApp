import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getPalette, getStatusTone } from "../components/theme";

const STORAGE_KEY = "mysti.themePreference";

/** "system" | "light" | "dark" - null until storage has been read. */
const ThemeContext = createContext({
  scheme: "dark",
  preference: "system",
  setPreference: () => {},
  isLoadingPreference: true,
  c: getPalette("dark"),
  statusTone: getStatusTone("dark"),
  isDark: true,
});

/**
 * Resolves the effective scheme.
 *
 * `preference` is the user's choice; `systemScheme` is what the OS reports.
 * Keeping the preference as its own piece of state (rather than collapsing it
 * immediately) is what lets the Profile screen show "System" as still selected
 * after the OS flips to dark.
 */
export function ThemeProvider({ children }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState("system");
  const [isLoadingPreference, setIsLoadingPreference] = useState(true);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!active) return;
        if (stored === "light" || stored === "dark" || stored === "system") {
          setPreferenceState(stored);
        }
      })
      .catch((error) => {
        // A missing/unreadable preference is not fatal - fall back to system.
        console.warn("Could not read theme preference:", error);
      })
      .finally(() => {
        if (active) setIsLoadingPreference(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = (next) => {
    setPreferenceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch((error) =>
      console.warn("Could not save theme preference:", error),
    );
  };

  const scheme =
    preference === "system"
      ? systemScheme === "light"
        ? "light"
        : "dark"
      : preference;

  const value = useMemo(
    () => ({
      scheme,
      preference,
      setPreference,
      isLoadingPreference,
      c: getPalette(scheme),
      statusTone: getStatusTone(scheme),
      isDark: scheme === "dark",
    }),
    [scheme, preference, isLoadingPreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);

export default ThemeContext;
