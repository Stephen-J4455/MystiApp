import { useState, useEffect } from "react";
import { Platform, Linking } from "react-native";
import { supabase } from "../lib/supabase";
import Constants from "expo-constants";

const APP_VERSION = Constants.expoConfig?.version || "1.0.0";

export const useAppVersion = () => {
  const [versionChecked, setVersionChecked] = useState(false);
  const [canEnterApp, setCanEnterApp] = useState(false);
  const [updateModal, setUpdateModal] = useState({
    visible: false,
    title: "",
    message: "",
    downloadUrl: "",
    releaseNotes: "",
  });

  useEffect(() => {
    checkAppVersion();
  }, []);

  const checkAppVersion = async () => {
    try {
      const platform = Platform.OS === "web" ? "web" : Platform.OS;

      const { data: versionData, error } = await supabase
        .from("app_versions")
        .select("*")
        .eq("platform", platform)
        .single();

      if (error) {
        console.error("Error fetching app version:", error);
        // If we can't check version, allow access
        setCanEnterApp(true);
        setVersionChecked(true);
        return;
      }

      if (!versionData) {
        // No version data found, allow access
        setCanEnterApp(true);
        setVersionChecked(true);
        return;
      }

      const currentVersion = versionData.current_version;
      const minimumVersion = versionData.minimum_version;
      const isUpdateRequired = versionData.is_update_required;
      const downloadUrl = versionData.download_url;
      const updateUrl = versionData.update_url;
      const releaseNotes = versionData.release_notes;

      console.log("App version check:", {
        appVersion: APP_VERSION,
        currentVersion,
        minimumVersion,
        platform,
      });

      // Compare versions (simple string comparison for now)
      const needsUpdate = APP_VERSION < currentVersion;
      const isBelowMinimum = minimumVersion && APP_VERSION < minimumVersion;

      console.log("Version comparison:", {
        appVersion: APP_VERSION,
        currentVersion,
        needsUpdate,
        isBelowMinimum,
        platform,
      });

      if (platform === "web") {
        // For web, don't show update modal, allow access
        console.log("Web version check complete, allowing access");
        setCanEnterApp(true);
      } else if (platform === "android") {
        if (
          isBelowMinimum ||
          (isUpdateRequired && needsUpdate) ||
          needsUpdate
        ) {
          console.log("Android update needed, showing modal");
          // Show update modal for all updates (mandatory)
          setUpdateModal({
            visible: true,
            title: "Update Required",
            message:
              "A new version of the app is available and is required to continue using the app.",
            downloadUrl: downloadUrl || "",
            releaseNotes: releaseNotes || "",
          });
          setCanEnterApp(false);
        } else {
          console.log("No android update needed");
          setCanEnterApp(true);
        }
      } else {
        // iOS or other platforms - allow access for now
        setCanEnterApp(true);
      }

      setVersionChecked(true);
    } catch (error) {
      console.error("Error checking app version:", error);
      // On error, allow access
      setCanEnterApp(true);
      setVersionChecked(true);
    }
  };

  const handleDownload = () => {
    if (Platform.OS === "web") {
      window.location.reload();
    } else {
      // For mobile, open download link but keep modal visible
      // User can enter app after update is installed and app restarted
    }
  };

  return {
    versionChecked,
    canEnterApp,
    appVersion: APP_VERSION,
    updateModal,
    setUpdateModal,
    handleDownload,
  };
};
