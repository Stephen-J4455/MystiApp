import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fonts } from "./theme";
import { useTheme } from "../contexts/ThemeContext";
import { useDockVisibility } from "../contexts/DockVisibilityContext";
import { DOCK_BAR_HEIGHT, PRIMARY_TABS, moreItemsFor } from "../lib/dockNav";

const MORE_SLOT_WIDTH = 64;

/**
 * Bottom dock for the main app: four primary tabs with an animated centre
 * button that opens the remaining screens in a popup card.
 *
 * Native only. The web build keeps the existing top-bar overflow menu, so this
 * component returns null there and the caller is expected to gate on
 * `Platform.OS !== "web"`.
 *
 * Two deliberate differences from the admin app's dock:
 *
 * 1. It is NOT a React Navigation `tabBar` - the main app uses a single
 *    `Stack.Navigator`, not a `Tab.Navigator`. There are no tab routes or
 *    descriptors to read, so navigation goes through the navigator ref passed
 *    in by `App.js`. That also means no "back" semantics: every tab press is a
 *    plain `navigate`, and React Navigation pushes a new screen for a tab the
 *    user is already deep in. The `popToTop`-on-repeat behaviour people expect
 *    from a real tab bar is out of scope here; the More popup covers the
 *    overflow destinations instead.
 *
 * 2. The popup lives in a real `Modal`. This is the fix for the broken
 *    hamburger: the old menu was an in-tree `absoluteFill` overlay, which sat
 *    on top of the button that opened it and swallowed the tap - and because
 *    `pointerEvents` resolution is platform-dependent, it failed silently. A
 *    `Modal` is a separate native window, so nothing in the tree can cover it
 *    and the tap can never be eaten.
 */
export default function DockTabBar({
  navigationRef,
  currentRouteName,
  account,
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const { dockVisible } = useDockVisibility();
  const { c } = useTheme();

  // The More popup lists only what this account can actually open. A Pro Super
  // Agent and a normal user get different menus, and the entries they are NOT
  // shown are exactly the ones whose screen would `replace("Home")` on mount -
  // which is what made a Pro Super Agent's "Offers" tap appear to reopen the
  // previous screen. Filtered here rather than gated on tap.
  const moreItems = useMemo(
    () => moreItemsFor(account || {}),
    // `ownsWallet` is part of the input and MUST be listed. Leaving it out
    // would let the memo return a stale menu after a first top-up creates the
    // wallet row, or after a demotion - the Wallet entry would simply not
    // appear until something else forced a re-render.
    [
      account?.isSuperAgent,
      account?.isEnterprise,
      account?.ownsWallet,
      account?.isNormalUser,
    ],
  );

  const popupAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const iconAnim = useRef(new Animated.Value(0)).current;

  // Floating entrance for the popup card.
  useEffect(() => {
    if (moreOpen) {
      popupAnim.setValue(0);
      Animated.spring(popupAnim, {
        toValue: 1,
        damping: 16,
        stiffness: 190,
        mass: 0.7,
        useNativeDriver: true,
      }).start();
    }
  }, [moreOpen, popupAnim]);

  // Rotate the centre icon 135deg -> an "add"/"close" morph.
  useEffect(() => {
    Animated.timing(iconAnim, {
      toValue: moreOpen ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [moreOpen, iconAnim]);

  // Gentle attention pulse on the centre button while the popup is closed.
  useEffect(() => {
    if (moreOpen) {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(2600),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1400,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );

    loop.start();
    return () => loop.stop();
  }, [moreOpen, pulseAnim]);

  const rotateIcon = iconAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "135deg"],
  });

  const pulseScale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.45],
  });

  const pulseOpacity = pulseAnim.interpolate({
    inputRange: [0, 0.2, 1],
    outputRange: [0, 0.35, 0],
  });

  const cardTranslateY = popupAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [28, 0],
  });

  const cardScale = popupAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.9, 1],
  });

  const goTo = (routeName) => {
    const nav = navigationRef?.current;
    if (!nav) return;
    // `navigate` on the current screen is a no-op in React Navigation, which
    // would make re-tapping the active tab feel broken. Navigate to the top of
    // that screen's stack instead so the press always does something.
    if (routeName === currentRouteName && nav.canGoBack?.()) {
      nav.popToTop();
      return;
    }
    nav.navigate(routeName);
  };

  const closeMore = () => setMoreOpen(false);

  const goToMoreItem = (routeName) => {
    closeMore();
    // Let the popup start dismissing before navigating so the screen change
    // doesn't feel like the card is snapping shut over the new view.
    setTimeout(() => {
      const nav = navigationRef?.current;
      if (nav) nav.navigate(routeName);
    }, 140);
  };

  const leftTabs = PRIMARY_TABS.slice(0, 2);
  const rightTabs = PRIMARY_TABS.slice(2);

  const moreIsActive = moreItems.some(
    (item) => item.routeName === currentRouteName,
  );

  const renderTabSlot = (tab) => {
    const isFocused = currentRouteName === tab.routeName;

    return (
      <Pressable
        key={tab.routeName}
        accessibilityRole="button"
        accessibilityState={isFocused ? { selected: true } : {}}
        accessibilityLabel={tab.label}
        onPress={() => goTo(tab.routeName)}
        style={styles.tabSlot}
      >
        <View style={styles.iconWrap}>
          <View style={[styles.iconPill, isFocused && styles.iconPillActive]}>
            <Ionicons
              name={isFocused ? tab.activeIcon : tab.icon}
              size={19}
              color={isFocused ? c.textInverse : c.textMuted}
            />
          </View>
        </View>
        <Text
          numberOfLines={1}
          style={[styles.label, { color: isFocused ? c.mint : c.textMuted }]}
        >
          {tab.label}
        </Text>
      </Pressable>
    );
  };

  // Built as a themed stylesheet: the palette flips with the scheme, and a
  // module-level StyleSheet would freeze one scheme's colours.
  const styles = buildStyles(c);

  return (
    <>
      {dockVisible ? (
        <View
          pointerEvents="box-none"
          style={[styles.dockWrapper, { paddingBottom: insets.bottom }]}
        >
          <View style={styles.dock}>
            <View style={styles.dockSide}>{leftTabs.map(renderTabSlot)}</View>

            <View style={styles.moreSlot} pointerEvents="box-none">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="More options"
                accessibilityState={{ expanded: moreOpen }}
                onPress={() => setMoreOpen(true)}
                hitSlop={6}
                style={styles.moreTouchable}
              >
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.morePulse,
                    {
                      backgroundColor: c.mint,
                      opacity: pulseOpacity,
                      transform: [{ scale: pulseScale }],
                    },
                  ]}
                />
                <Animated.View
                  style={[
                    styles.moreButton,
                    { backgroundColor: c.mint },
                    moreIsActive && !moreOpen && styles.moreButtonActive,
                    { transform: [{ rotate: rotateIcon }] },
                  ]}
                >
                  <Ionicons name="add" size={24} color={c.onAccent} />
                </Animated.View>
              </Pressable>
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  { color: moreOpen || moreIsActive ? c.mint : c.textMuted },
                ]}
              >
                More
              </Text>
            </View>

            <View style={styles.dockSide}>{rightTabs.map(renderTabSlot)}</View>
          </View>
        </View>
      ) : null}

      <Modal
        visible={moreOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeMore}
      >
        <View style={styles.backdrop}>
          {/* Tapping the dimmed area dismisses. `box-none` on the container
              above means this scrim - not the container - owns the dismissal,
              so a stray tap between cards doesn't leak through. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeMore}
            accessibilityLabel="Close menu"
          />

          <Animated.View
            style={[
              styles.card,
              {
                // Sit just above the docked bar plus the safe-area inset.
                marginBottom: insets.bottom + DOCK_BAR_HEIGHT + 12,
                opacity: popupAnim,
                transform: [
                  { translateY: cardTranslateY },
                  { scale: cardScale },
                ],
              },
            ]}
          >
            <View style={styles.cardHeader}>
              <Text style={[styles.cardTitle, { color: c.mint }]}>
                All tools
              </Text>
              <Pressable
                onPress={closeMore}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={10}
              >
                <Ionicons name="close" size={20} color={c.textMuted} />
              </Pressable>
            </View>

            <View style={styles.grid}>
              {moreItems.map((item) => (
                <Pressable
                  key={item.routeName}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  onPress={() => goToMoreItem(item.routeName)}
                  style={({ pressed }) => [
                    styles.gridItem,
                    pressed && styles.gridItemPressed,
                  ]}
                >
                  <View
                    style={[styles.gridIcon, { backgroundColor: c.surface }]}
                  >
                    <Ionicons name={item.icon} size={21} color={c.mint} />
                  </View>
                  <Text
                    style={[styles.gridLabel, { color: c.textPrimary }]}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                  <Text
                    style={[styles.gridCaption, { color: c.textMuted }]}
                    numberOfLines={1}
                  >
                    {item.caption}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

const buildStyles = (c) =>
  StyleSheet.create({
    dockWrapper: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 20,
    },
    dock: {
      height: DOCK_BAR_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.tabBar,
      borderTopWidth: 1,
      borderTopColor: c.hairlineStrong,
      paddingHorizontal: 6,
      paddingVertical: 6,
      ...Platform.select({
        ios: {
          shadowColor: c.shadow,
          shadowOffset: { width: 0, height: -3 },
          shadowOpacity: 0.9,
          shadowRadius: 8,
        },
        android: { elevation: 16 },
        default: {
          boxShadow: `0 -2px 8px ${c.shadow}`,
        },
      }),
    },
    dockSide: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-evenly",
    },
    tabSlot: {
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    // Wrapper so the icon can sit inside a pill without the pill's own
    // `overflow: hidden` clipping anything.
    iconWrap: {
      alignItems: "center",
      justifyContent: "center",
    },
    iconPill: {
      width: 42,
      height: 30,
      // A full pill (height / 2) reads as a proper rounded pill on Android,
      // where a partial radius like 12 can render as a near-square block.
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
      // Needed so the background actually clips to the radius on Android.
      overflow: "hidden",
    },
    iconPillActive: {
      backgroundColor: c.mint,
    },
    label: {
      fontFamily: fonts.bodyBold,
      fontSize: 9,
      letterSpacing: 0.2,
      marginTop: 3,
      textAlign: "center",
    },
    moreSlot: {
      width: MORE_SLOT_WIDTH,
      alignItems: "center",
      justifyContent: "center",
    },
    moreTouchable: {
      alignItems: "center",
      justifyContent: "center",
    },
    morePulse: {
      position: "absolute",
      width: 36,
      height: 36,
      borderRadius: 18,
    },
    moreButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    moreButtonActive: {
      opacity: 0.85,
    },
    backdrop: {
      flex: 1,
      backgroundColor: c.menuBackdrop,
      justifyContent: "flex-end",
    },
    card: {
      marginHorizontal: 16,
      borderRadius: 24,
      backgroundColor: c.canvasRaised,
      borderWidth: 1,
      borderColor: c.hairline,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 18,
      ...Platform.select({
        ios: {
          shadowColor: c.shadow,
          shadowOffset: { width: 0, height: -6 },
          shadowOpacity: 1,
          shadowRadius: 20,
        },
        android: { elevation: 20 },
        default: {
          boxShadow: `0 -6px 20px ${c.shadow}`,
        },
      }),
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 12,
    },
    cardTitle: {
      fontFamily: fonts.display,
      fontSize: 15,
    },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      // `flex-start` + gap, not `space-between`. The menu no longer has a fixed
      // nine items, so the row count varies by account (4 items for a normal
      // user, 9 for an Enterprise Super Agent) and `space-between` would fling
      // a short last row across the full width.
      justifyContent: "flex-start",
      columnGap: "3%",
      rowGap: 6,
    },
    gridItem: {
      width: "31%",
      alignItems: "center",
      paddingVertical: 10,
      borderRadius: 16,
    },
    gridItemPressed: {
      opacity: 0.6,
    },
    gridIcon: {
      width: 44,
      height: 44,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 8,
    },
    gridLabel: {
      fontFamily: fonts.bodyBold,
      fontSize: 12,
    },
    gridCaption: {
      fontFamily: fonts.body,
      fontSize: 9,
      marginTop: 2,
    },
  });
