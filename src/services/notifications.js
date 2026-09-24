/**
 * Push Notification Service for Mystiwan-E-Business
 * Handles registration, permissions, and notification handling
 * Uses expo-notifications
 */

import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { supabase } from "../lib/supabase";

// Conditionally import expo-notifications - will be null/fail in Expo Go
let Notifications = null;
try {
  Notifications = require("expo-notifications");

  // Configure how notifications are displayed when app is in foreground
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
} catch (error) {
  console.log("expo-notifications not available (expected in Expo Go SDK 53+)");
}

/**
 * Check if notifications are available (not in Expo Go)
 * @returns {boolean}
 */
function isNotificationsAvailable() {
  // Check if we're in Expo Go
  const isExpoGo = Constants.appOwnership === "expo";
  if (isExpoGo) {
    console.log("Running in Expo Go - notifications disabled");
    return false;
  }
  return Notifications !== null;
}

/**
 * Register for push notifications and get FCM token
 * Works for standalone/production apps using FCM
 * @returns {Promise<string|null>} FCM push token or null
 */
export async function registerForPushNotifications() {
  if (!isNotificationsAvailable()) {
    console.log("Notifications not available - skipping registration");
    return null;
  }

  let token = null;

  if (Platform.OS === "android") {
    // Create notification channels for Android
    await Notifications.setNotificationChannelAsync("transactions", {
      name: "Transactions",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FF231F7C",
      sound: "default",
    });

    await Notifications.setNotificationChannelAsync("updates", {
      name: "Updates",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250],
      lightColor: "#FFA500",
    });
  }

  if (Device.isDevice || Platform.OS === "web") {
    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.log("Failed to get push notification permission");
      return null;
    }

    try {
      // Get FCM device push token (works in standalone builds)
      console.log("Getting FCM device push token...");
      const deviceToken = await Notifications.getDevicePushTokenAsync();
      token = deviceToken.data;
      console.log("FCM Push Token obtained:", token);
    } catch (error) {
      console.error("Error getting FCM push token:", error);
      return null;
    }
  } else {
    console.log("Must use physical device for Push Notifications");
  }

  return token;
}

/**
 * Save push token to user profile in database
 * @param {string} token - Expo push token
 * @param {string} userId - User ID
 */
export async function savePushToken(token, userId) {
  if (!token || !userId) return;

  try {
    // Determine platform
    const platform = Platform.OS; // 'ios', 'android', or 'web'

    // Determine token type (FCM or Expo)
    const tokenType = token.startsWith("ExponentPushToken") ? "expo" : "fcm";
    console.log(`Token type detected: ${tokenType}`);

    // Save to user_push_tokens table
    console.log("Saving push token to user_push_tokens...");

    // Build upsert data - try with token_type first
    const upsertData = {
      user_id: userId,
      push_token: token,
      platform: platform,
      token_type: tokenType,
      updated_at: new Date().toISOString(),
    };

    // Try upsert with user_id,platform constraint
    let tokenError = null;
    const { error: error1 } = await supabase
      .from("user_push_tokens")
      .upsert(upsertData, { onConflict: "user_id,platform" });

    tokenError = error1;

    // If constraint doesn't exist, try without it
    if (error1?.message?.includes("constraint") || error1?.code === "42P10") {
      console.log(
        "Unique constraint not found, trying insert/update approach...",
      );

      // Check if token exists
      const { data: existing } = await supabase
        .from("user_push_tokens")
        .select("id")
        .eq("user_id", userId)
        .eq("platform", platform)
        .single();

      if (existing) {
        // Update existing
        const { error: updateError } = await supabase
          .from("user_push_tokens")
          .update(upsertData)
          .eq("user_id", userId)
          .eq("platform", platform);
        tokenError = updateError;
      } else {
        // Insert new
        const { error: insertError } = await supabase
          .from("user_push_tokens")
          .insert(upsertData);
        tokenError = insertError;
      }
    }

    // If token_type column doesn't exist, retry without it
    if (
      tokenError?.message?.includes("token_type") ||
      tokenError?.code === "42703"
    ) {
      console.log("token_type column not found, saving without it...");
      delete upsertData.token_type;

      const { error: error2 } = await supabase
        .from("user_push_tokens")
        .upsert(upsertData, { onConflict: "user_id,platform" });
      tokenError = error2;

      // Fallback to insert/update if still failing
      if (error2) {
        const { data: existing } = await supabase
          .from("user_push_tokens")
          .select("id")
          .eq("user_id", userId)
          .eq("platform", platform)
          .single();

        if (existing) {
          const { error: updateError } = await supabase
            .from("user_push_tokens")
            .update(upsertData)
            .eq("id", existing.id);
          tokenError = updateError;
        } else {
          const { error: insertError } = await supabase
            .from("user_push_tokens")
            .insert(upsertData);
          tokenError = insertError;
        }
      }
    }

    if (tokenError) {
      console.error("Error saving to user_push_tokens:", tokenError);
      throw new Error(
        `Failed to save push token: ${tokenError.message || "unknown database error"}`,
      );
    }

    console.log("Push token saved to user_push_tokens successfully");
    return true;
  } catch (error) {
    console.error("Error saving push token:", error);
    return false;
  }
}

/**
 * Set up notification listeners
 * @param {Function} onNotificationReceived - Callback for received notifications
 * @param {Function} onNotificationTapped - Callback for tapped notifications
 * @returns {Object} Subscriptions object with listeners
 */
export function setupNotificationListeners(
  onNotificationReceived,
  onNotificationTapped,
) {
  if (!isNotificationsAvailable()) {
    console.log("Notifications not available - listeners disabled");
    return { remove: () => {} };
  }

  // Listener for notifications received while app is in foreground
  const notificationListener = Notifications.addNotificationReceivedListener(
    (notification) => {
      console.log("Notification received:", notification);
      if (onNotificationReceived) {
        onNotificationReceived(notification);
      }
    },
  );

  // Listener for when user taps on notification
  const responseListener =
    Notifications.addNotificationResponseReceivedListener((response) => {
      console.log("Notification tapped:", response);
      if (onNotificationTapped) {
        onNotificationTapped(response);
      }
    });

  // Return combined subscription for cleanup
  return {
    remove: () => {
      notificationListener.remove();
      responseListener.remove();
    },
  };
}

/**
 * Send a local notification
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data
 */
export async function sendLocalNotification(title, body, data = {}) {
  if (!isNotificationsAvailable()) {
    console.log("Notifications not available - cannot send local notification");
    return;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: true,
    },
    trigger: null, // Send immediately
  });
}
