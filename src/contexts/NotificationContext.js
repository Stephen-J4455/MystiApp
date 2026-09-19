import React, { createContext, useContext, useState, useCallback } from "react";
import { View } from "react-native";
import { Notification } from "../components/Notification";

const NotificationContext = createContext();

export const useNotification = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error(
      "useNotification must be used within a NotificationProvider"
    );
  }
  return context;
};

export const NotificationProvider = ({ children }) => {
  const [notifications, setNotifications] = useState([]);

  const showNotification = useCallback(
    (type, title, message, duration = 4000) => {
      const id = Date.now().toString();
      const notification = {
        id,
        type,
        title,
        message,
        visible: true,
      };

      setNotifications((prev) => [...prev, notification]);

      // Auto-hide after duration
      setTimeout(() => {
        hideNotification(id);
      }, duration);

      return id;
    },
    []
  );

  const hideNotification = useCallback((id) => {
    setNotifications((prev) =>
      prev.map((notif) =>
        notif.id === id ? { ...notif, visible: false } : notif
      )
    );

    // Remove from state after animation
    setTimeout(() => {
      setNotifications((prev) => prev.filter((notif) => notif.id !== id));
    }, 300);
  }, []);

  const showSuccess = useCallback(
    (title, message, duration) =>
      showNotification("success", title, message, duration),
    [showNotification]
  );

  const showError = useCallback(
    (title, message, duration) =>
      showNotification("error", title, message, duration),
    [showNotification]
  );

  const showWarning = useCallback(
    (title, message, duration) =>
      showNotification("warning", title, message, duration),
    [showNotification]
  );

  const showInfo = useCallback(
    (title, message, duration) =>
      showNotification("info", title, message, duration),
    [showNotification]
  );

  // Alert.alert replacement functions
  const alert = useCallback(
    (title, message) => showNotification("info", title, message),
    [showNotification]
  );

  const alertSuccess = useCallback(
    (title, message) => showNotification("success", title, message),
    [showNotification]
  );

  const alertError = useCallback(
    (title, message) => showNotification("error", title, message),
    [showNotification]
  );

  return (
    <NotificationContext.Provider
      value={{
        showNotification,
        hideNotification,
        showSuccess,
        showError,
        showWarning,
        showInfo,
        alert,
        alertSuccess,
        alertError,
      }}>
      {children}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
        {notifications.map((notification) => (
          <Notification
            key={notification.id}
            visible={notification.visible}
            type={notification.type}
            title={notification.title}
            message={notification.message}
            onClose={() => hideNotification(notification.id)}
          />
        ))}
      </View>
    </NotificationContext.Provider>
  );
};
