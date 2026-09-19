import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import colors from "../components/theme";

const UpdateNotification = ({
  visible,
  title,
  message,
  downloadUrl,
  onDownload,
  releaseNotes,
}) => {
  const handleDownload = () => {
    if (downloadUrl) {
      Linking.openURL(downloadUrl);
    }
    if (onDownload) {
      onDownload();
    }
  };

  if (!visible) return null;

  return (
    <View style={styles.overlay}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Ionicons name="download" size={32} color={colors.primary} />
          <Text style={styles.title}>{title}</Text>
        </View>

        <Text style={styles.message}>{message}</Text>

        {releaseNotes && (
          <View style={styles.releaseNotesContainer}>
            <Text style={styles.releaseNotesTitle}>What's New:</Text>
            <Text style={styles.releaseNotes}>{releaseNotes}</Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.downloadButton}
          onPress={handleDownload}>
          <Ionicons name="download-outline" size={20} color="#fff" />
          <Text style={styles.downloadButtonText}>Download Update</Text>
        </TouchableOpacity>

        <Text style={styles.requiredText}>
          This update is required to continue using the app
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    zIndex: 9999,
  },
  container: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 25,
    width: "100%",
    maxWidth: 400,
    elevation: 10,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 5,
    },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  header: {
    alignItems: "center",
    marginBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.primary,
    marginTop: 10,
    textAlign: "center",
  },
  message: {
    fontSize: 16,
    color: colors.secondary,
    textAlign: "center",
    lineHeight: 24,
    marginBottom: 20,
  },
  releaseNotesContainer: {
    backgroundColor: colors.light,
    borderRadius: 12,
    padding: 15,
    marginBottom: 25,
  },
  releaseNotesTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: colors.primary,
    marginBottom: 8,
  },
  releaseNotes: {
    fontSize: 14,
    color: colors.secondary,
    lineHeight: 20,
  },
  downloadButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 12,
    marginBottom: 15,
  },
  downloadButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
    marginLeft: 8,
  },
  requiredText: {
    fontSize: 12,
    color: colors.secondary,
    textAlign: "center",
    fontStyle: "italic",
  },
});

export default UpdateNotification;
