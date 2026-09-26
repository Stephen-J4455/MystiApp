import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DOCK_BAR_HEIGHT } from "../lib/dockNav";

/**
 * Bottom padding a scrollable screen needs so its final row clears the floating
 * bottom dock.
 *
 * The dock is absolutely positioned, so it draws over the scroll view rather
 * than taking up layout space - without this, the last card (and whatever
 * bottom-anchored action sits under it) sits permanently underneath the bar and
 * is unreachable.
 *
 * Web returns 0: the dock is native-only there, so the existing spacing is
 * already correct and adding more would just leave a gap.
 *
 * Spread the result into a `contentContainerStyle`:
 *   contentContainerStyle={[styles.scrollContent, dockBottomPadding]}
 */
export function useDockBottomPadding(extra = 0) {
  const insets = useSafeAreaInsets();
  if (Platform.OS === "web") return extra;
  return DOCK_BAR_HEIGHT + insets.bottom + extra;
}

export default useDockBottomPadding;
