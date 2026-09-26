import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
  StyleSheet,
  StatusBar,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { removeChannelSafe, uniqueTopic } from "../lib/realtime";
import { sendLocalNotification } from "../services/notifications";
import { useTheme } from "../contexts/ThemeContext";
import { EmptyState, RowIcon } from "../components/ui";
import { fonts } from "../components/theme";

// Notification kind -> icon + palette token. The old screen used hardcoded
// hexes here, which were invisible (or invisible-wrong) in light mode.
const KIND_META = {
  success: { icon: "checkmark-circle", tint: "mint" },
  info: { icon: "information-circle", tint: "sky" },
  security: { icon: "shield-checkmark", tint: "rose" },
  reminder: { icon: "time", tint: "amber" },
  welcome: { icon: "heart", tint: "mint" },
};

const kindMeta = (type) =>
  KIND_META[type] || { icon: "notifications", tint: "mintDim" };

export default function NotificationsScreen({ navigation }) {
  const { c, isDark } = useTheme();
  // Edge-to-edge on Android with no navigator header, so the screen insets
  // itself. iOS already spaces this header, so the inset is Android-only.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "android" ? insets.top : 0;
  const s = useNotifStyles(c, topInset);

  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const skeletonOpacity = useRef(new Animated.Value(0.6)).current;
  // The subscription is created inside an async setup fn, so it has to be
  // parked in a ref that cleanup can reach. A closure variable is still null
  // if the effect unmounts during the awaits, which leaks the channel and lets
  // the next mount collide with it.
  const notifChannelRef = useRef(null);

  useEffect(() => {
    fetchNotifications();
    setupRealtimeSubscription();

    return () => {
      removeChannelSafe(notifChannelRef.current);
    };
  }, []);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(skeletonOpacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(skeletonOpacity, {
          toValue: 0.6,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [skeletonOpacity]);

  const setupRealtimeSubscription = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const channel = supabase
          .channel(uniqueTopic("notifications_realtime"))
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "notifications",
              filter: `user_id=eq.${user.id}`,
            },
            (payload) => {
              console.log("New notification received:", payload);
              // Add new notification to the list
              setNotifications((prev) => [payload.new, ...prev]);

              // Send push notification for all new notifications
              sendLocalNotification(
                payload.new.title || "New Notification",
                payload.new.message || "You have a new notification",
              ).catch((error) => {
                console.error("Error sending local notification:", error);
              });
            },
          )
          .on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "notifications",
              filter: `user_id=eq.${user.id}`,
            },
            (payload) => {
              console.log("Notification updated:", payload);
              // Update the notification in the list
              setNotifications((prev) =>
                prev.map((notif) =>
                  notif.id === payload.new.id ? payload.new : notif,
                ),
              );

              // Note: Removed push notification for read status changes to avoid spam
            },
          )
          .on(
            "postgres_changes",
            {
              event: "DELETE",
              schema: "public",
              table: "notifications",
              filter: `user_id=eq.${user.id}`,
            },
            (payload) => {
              console.log("Notification deleted:", payload);
              // Remove the notification from the list
              setNotifications((prev) =>
                prev.filter((notif) => notif.id !== payload.old.id),
              );

              // Note: Removed push notification for deletions to avoid confusion
            },
          )
          .subscribe();

        notifChannelRef.current = channel;
      }
    } catch (error) {
      console.error("Error setting up realtime subscription:", error);
    }
  };

  const fetchNotifications = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data, error } = await supabase
          .from("notifications")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });

        if (error) {
          console.error("Error fetching notifications:", error);
        } else {
          setNotifications(data || []);
        }
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoading(false);
    }
  };

  const markAsRead = async (id) => {
    try {
      console.log("Marking notification as read:", id);
      const { error } = await supabase
        .from("notifications")
        .update({ read: true })
        .eq("id", id);

      if (error) {
        console.error("Error marking notification as read:", error);
      } else {
        console.log("Notification marked as read successfully:", id);
        setNotifications(
          notifications.map((notif) =>
            notif.id === id ? { ...notif, read: true } : notif,
          ),
        );
      }
    } catch (error) {
      console.error("Error marking as read:", error);
    }
  };

  const markAllAsRead = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { error } = await supabase
          .from("notifications")
          .update({ read: true })
          .eq("user_id", user.id)
          .eq("read", false);

        if (!error) {
          setNotifications(
            notifications.map((notif) => ({ ...notif, read: true })),
          );
        }
      }
    } catch (error) {
      console.error("Error marking all as read:", error);
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  // The old screen showed a truncated 5-word "title" ABOVE the full message,
  // so every row displayed its body text twice. `notifications.title` is the
  // real title field, so use it when present and fall back to the first clause
  // of the message only when the row genuinely has no title.
  const titleOf = (notification) => {
    const title = String(notification?.title || "").trim();
    if (title) return title;
    const message = String(notification?.message || "");
    const firstClause = message.split(/[.!?\n]/)[0]?.trim();
    return firstClause || "Notification";
  };

  const messageOf = (notification) =>
    String(notification?.message || "").trim();

  const formatTime = (timestamp) => {
    const now = new Date();
    const created = new Date(timestamp);
    const diffInHours = Math.floor((now - created) / (1000 * 60 * 60));

    if (diffInHours < 1) return "Just now";
    if (diffInHours < 24) return `${diffInHours} hours ago`;
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 7) return `${diffInDays} days ago`;
    return created.toLocaleDateString();
  };

  return (
    <View style={s.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle={isDark ? "light-content" : "dark-content"}
      />

      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.header}>
          <TouchableOpacity
            style={s.backButton}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={20} color={c.textPrimary} />
          </TouchableOpacity>
          <View style={s.headerTextWrap}>
            <Text style={s.headerTitle}>Notifications</Text>
            {unreadCount > 0 ? (
              <Text style={s.headerSubtitle}>
                {unreadCount} unread
                {unreadCount === 1 ? "" : "s"}
              </Text>
            ) : null}
          </View>
          {unreadCount > 0 ? (
            <TouchableOpacity
              style={s.markAllButton}
              onPress={markAllAsRead}
              activeOpacity={0.75}
              accessibilityRole="button"
            >
              <Text style={s.markAllText}>Mark all read</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {loading ? (
          <View style={s.placeholderList}>
            {[0, 1, 2, 3].map((index) => (
              <Animated.View
                key={`notification-placeholder-${index}`}
                style={[
                  s.notificationPlaceholder,
                  { opacity: skeletonOpacity },
                ]}
              >
                <View style={s.placeholderIcon} />
                <View style={s.placeholderContent}>
                  <View style={s.placeholderLine} />
                  <View style={s.placeholderLineShort} />
                </View>
              </Animated.View>
            ))}
          </View>
        ) : notifications.length === 0 ? (
          <EmptyState
            icon="notifications-off-outline"
            title="You're all caught up"
            message="Order updates and account alerts will show up here."
          />
        ) : (
          <View style={s.list}>
            {notifications.map((notification) => {
              const meta = kindMeta(notification.status || "info");
              const title = titleOf(notification);
              const message = messageOf(notification);
              return (
                <TouchableOpacity
                  key={notification.id}
                  style={[s.item, notification.read ? null : s.itemUnread]}
                  onPress={() => markAsRead(notification.id)}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={`${title}. ${formatTime(
                    notification.created_at,
                  )}`}
                >
                  <RowIcon icon={meta.icon} tint={c[meta.tint]} />
                  <View style={s.itemBody}>
                    <Text
                      style={[
                        s.itemTitle,
                        notification.read ? null : s.itemTitleUnread,
                      ]}
                      numberOfLines={2}
                    >
                      {title}
                    </Text>
                    {message && message !== title ? (
                      <Text style={s.itemMessage} numberOfLines={3}>
                        {message}
                      </Text>
                    ) : null}
                    <Text style={s.itemTime}>
                      {formatTime(notification.created_at)}
                    </Text>
                  </View>
                  {!notification.read ? <View style={s.unreadDot} /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// Cross-platform elevation. Mirrors HomeScreen/ProfileScreen: `boxShadow` for
// web (where `shadow*` flattens), native props elsewhere, palette tone.
const shadow = (elevation, shadowOpacity = 0.16, tone = "#000000") =>
  Platform.select({
    ios: {
      shadowColor: tone,
      shadowOffset: { width: 0, height: elevation },
      shadowOpacity,
      shadowRadius: elevation * 1.6,
    },
    android: { elevation },
    default: {
      boxShadow: `${tone}${Math.round(shadowOpacity * 255)
        .toString(16)
        .padStart(2, "0")} 0px ${elevation}px ${elevation * 1.8}px`,
    },
  });

const useNotifStyles = (c, topInset) =>
  useMemo(() => buildStyles(c, topInset), [c, topInset]);

// `topInset` is the Android status-bar height - see HistoryScreen for why.
const buildStyles = (c, topInset = 0) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.canvas,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingBottom: 36,
    },

    /* ---------- Header ---------- */
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingTop: 8 + topInset,
      paddingBottom: 18,
    },
    backButton: {
      width: 40,
      height: 40,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    headerTextWrap: {
      flex: 1,
    },
    headerTitle: {
      fontFamily: fonts.display,
      fontSize: 21,
      color: c.textPrimary,
    },
    headerSubtitle: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      color: c.mintDim,
      marginTop: 2,
    },
    markAllButton: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
    },
    markAllText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.mint,
    },

    /* ---------- List ---------- */
    list: {
      gap: 10,
    },
    item: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      backgroundColor: c.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.hairline,
      padding: 14,
      ...shadow(3, 0.14, c.shadow),
    },
    // Unread rows get a tinted wash plus a leading accent edge so they read as
    // distinct at a glance without relying on the dot alone.
    itemUnread: {
      backgroundColor: `${c.mint}0D`,
      borderColor: `${c.mint}44`,
      borderLeftWidth: 3,
    },
    itemBody: {
      flex: 1,
    },
    itemTitle: {
      fontFamily: fonts.body,
      fontSize: 14.5,
      color: c.textSecondary,
    },
    itemTitleUnread: {
      fontFamily: fonts.bodyBold,
      color: c.textPrimary,
    },
    itemMessage: {
      fontFamily: fonts.body,
      fontSize: 12.5,
      lineHeight: 18,
      color: c.textMuted,
      marginTop: 3,
    },
    itemTime: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 7,
    },
    unreadDot: {
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: c.mint,
      marginTop: 6,
    },

    /* ---------- Skeleton ---------- */
    placeholderList: {
      gap: 12,
    },
    notificationPlaceholder: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      height: 74,
      borderRadius: 20,
      backgroundColor: c.skeleton,
      padding: 14,
    },
    placeholderIcon: {
      width: 36,
      height: 36,
      borderRadius: 12,
      backgroundColor: c.surfaceHover,
    },
    placeholderContent: {
      flex: 1,
      gap: 8,
    },
    placeholderLine: {
      height: 12,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
      width: "75%",
    },
    placeholderLineShort: {
      height: 10,
      borderRadius: 5,
      backgroundColor: c.surfaceHover,
      width: "55%",
    },
  });
