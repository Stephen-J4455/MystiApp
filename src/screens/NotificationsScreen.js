import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
  StyleSheet,
  StatusBar,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { sendLocalNotification } from "../services/notifications";
import colors from "../components/theme";

export default function NotificationsScreen({ navigation }) {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const skeletonOpacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    fetchNotifications();
    setupRealtimeSubscription();
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
      ])
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
          .channel("notifications_realtime")
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
                payload.new.message || "You have a new notification"
              ).catch((error) => {
                console.error("Error sending local notification:", error);
              });
            }
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
                  notif.id === payload.new.id ? payload.new : notif
                )
              );

              // Note: Removed push notification for read status changes to avoid spam
            }
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
                prev.filter((notif) => notif.id !== payload.old.id)
              );

              // Note: Removed push notification for deletions to avoid confusion
            }
          )
          .subscribe();
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
            notif.id === id ? { ...notif, read: true } : notif
          )
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
            notifications.map((notif) => ({ ...notif, read: true }))
          );
        }
      }
    } catch (error) {
      console.error("Error marking all as read:", error);
    }
  };

  const getNotificationIcon = (type) => {
    switch (type) {
      case "success":
        return "checkmark-circle";
      case "info":
        return "information-circle";
      case "security":
        return "shield-checkmark";
      case "reminder":
        return "time";
      case "welcome":
        return "heart";
      default:
        return "notifications";
    }
  };

  const getNotificationColor = (type) => {
    switch (type) {
      case "success":
        return "#27ae60";
      case "info":
        return "#3498db";
      case "security":
        return "#e74c3c";
      case "reminder":
        return "#f39c12";
      case "welcome":
        return "#9b59b6";
      default:
        return colors.primary;
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

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
    <View style={styles.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="dark-content"
      />

      {/* Floating Back Button */}
      <TouchableOpacity
        style={styles.floatingBackButton}
        onPress={() => navigation.goBack()}
      >
        <View style={styles.backButtonCircle}>
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </View>
      </TouchableOpacity>

      <ScrollView style={styles.content}>
        <View style={styles.contentHeader}>
          <Text style={styles.screenTitle}>Notifications</Text>
          {unreadCount > 0 && (
            <TouchableOpacity
              style={styles.markAllButtonContent}
              onPress={markAllAsRead}
            >
              <Text style={styles.markAllText}>Mark All Read</Text>
            </TouchableOpacity>
          )}
        </View>
        {loading ? (
          <View style={styles.placeholderList}>
            {[0, 1, 2, 3].map((index) => (
              <Animated.View
                key={`notification-placeholder-${index}`}
                style={[
                  styles.notificationPlaceholder,
                  { opacity: skeletonOpacity },
                ]}
              >
                <View style={styles.placeholderIcon} />
                <View style={styles.placeholderContent}>
                  <View style={styles.placeholderLine} />
                  <View style={styles.placeholderLineShort} />
                  <View style={styles.placeholderLineTiny} />
                </View>
              </Animated.View>
            ))}
          </View>
        ) : notifications.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="notifications-off" size={64} color={colors.tint} />
            <Text style={styles.emptyTitle}>No Notifications</Text>
            <Text style={styles.emptyMessage}>
              You're all caught up! Check back later for updates.
            </Text>
          </View>
        ) : (
          notifications.map((notification) => (
            <TouchableOpacity
              key={notification.id}
              style={[
                styles.notificationItem,
                !notification.read && styles.unreadItem,
              ]}
              onPress={() => markAsRead(notification.id)}
            >
              <View style={styles.notificationIcon}>
                <Ionicons
                  name={getNotificationIcon(notification.status || "info")}
                  size={24}
                  color={getNotificationColor(notification.status || "info")}
                />
              </View>
              <View style={styles.notificationContent}>
                <Text
                  style={[
                    styles.notificationTitle,
                    !notification.read && styles.unreadText,
                  ]}
                >
                  {notification.message.split(" ").slice(0, 5).join(" ")}...
                </Text>
                <Text style={styles.notificationMessage}>
                  {notification.message}
                </Text>
                <Text style={styles.notificationTime}>
                  {formatTime(notification.created_at)}
                </Text>
              </View>
              {!notification.read && <View style={styles.unreadDot} />}
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.white,
  },
  floatingBackButton: {
    position: "absolute",
    top: 50,
    left: 20,
    zIndex: 10,
  },
  backButtonCircle: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: "rgba(255, 255, 255, 0.9)",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  contentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginTop: 110, // Accounts for floating back button
    marginBottom: 20,
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: "bold",
    color: colors.dark,
  },
  markAllButtonContent: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: colors.light,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 15,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.white,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
  },
  markAllButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.light,
  },
  markAllText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  content: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 100,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: colors.dark,
    marginTop: 20,
    marginBottom: 10,
  },
  emptyMessage: {
    fontSize: 14,
    color: colors.dark,
    opacity: 0.5,
    textAlign: "center",
    lineHeight: 22,
  },
  notificationItem: {
    flexDirection: "row",
    backgroundColor: colors.white,
    marginHorizontal: 20,
    marginVertical: 8,
    padding: 16,
    borderRadius: 20,
    elevation: 3,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    alignItems: "center",
  },
  unreadItem: {
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    backgroundColor: "#F0F9F9",
  },
  notificationIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.white,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 15,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  notificationContent: {
    flex: 1,
  },
  notificationTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.dark,
    opacity: 0.8,
    marginBottom: 2,
  },
  unreadText: {
    fontWeight: "800",
    opacity: 1,
  },
  notificationMessage: {
    fontSize: 14,
    color: colors.dark,
    opacity: 0.6,
    marginBottom: 6,
    lineHeight: 20,
  },
  notificationTime: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.4,
    fontWeight: "600",
  },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
    marginLeft: 10,
  },
  placeholderList: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  notificationPlaceholder: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.white,
    marginBottom: 16,
    padding: 16,
    borderRadius: 20,
  },
  placeholderIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.border,
    marginRight: 15,
  },
  placeholderContent: {
    flex: 1,
  },
  placeholderLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: "75%",
    marginBottom: 8,
  },
  placeholderLineShort: {
    height: 10,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: "60%",
    marginBottom: 8,
  },
  placeholderLineTiny: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
    width: "40%",
  },
});
