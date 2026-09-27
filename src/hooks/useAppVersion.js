import { useState, useEffect } from "react";
import { Platform } from "react-native";
import { supabase } from "../lib/supabase";
import Constants from "expo-constants";

const { getVersionStatus } = require("../lib/versionCheck");

const APP_VERSION = Constants.expoConfig?.version || "1.0.0";

export const useAppVersion = () => {
  const isWeb = Platform.OS === "web";
  const [versionChecked, setVersionChecked] = useState(false);
  const [canEnterApp, setCanEnterApp] = useState(isWeb);
  const [updateModal, setUpdateModal] = useState({
    visible: false,
    title: "",
    message: "",
    downloadUrl: "",
    releaseNotes: "",
  });

  useEffect(() => {
    if (Platform.OS === "web") {
      setCanEnterApp(true);
      setVersionChecked(true);
      return;
    }

    checkAppVersion();
  }, []);

  const checkAppVersion = async () => {
    try {
      const platform = Platform.OS === "web" ? "web" : Platform.OS;

      const { data: versionRows, error } = await supabase
        .from("app_versions")
        .select("*")
        .eq("platform", platform)
        .order("updated_at", { ascending: false })
        .limit(1);

      if (error) {
        console.error("Error fetching app version:", error);
        setCanEnterApp(true);
        setVersionChecked(true);
        return;
      }

      const versionData = Array.isArray(versionRows) ? versionRows[0] : null;

      if (!versionData) {
        setCanEnterApp(true);
        setVersionChecked(true);
        return;
      }

      const currentVersion = versionData.current_version || APP_VERSION;
      const minimumVersion = versionData.minimum_version || "";
      const isUpdateRequired = Boolean(versionData.is_update_required);
      const downloadUrl = versionData.download_url || "";
      const releaseNotes = versionData.release_notes || "";

      const { needsUpdate, isBelowMinimum } = getVersionStatus(
        APP_VERSION,
        currentVersion,
        minimumVersion,
      );


      if (platform === "web") {
        setCanEnterApp(true);
      } else if (platform === "android") {
        if (
          isBelowMinimum ||
          (isUpdateRequired && needsUpdate) ||
          needsUpdate
        ) {
          setUpdateModal({
            visible: true,
            title: "Update Required",
            message:
              "A new version of the app is available and is required to continue using the app.",
            downloadUrl,
            releaseNotes,
          });
          setCanEnterApp(false);
        } else {
          setCanEnterApp(true);
        }
      } else {
        setCanEnterApp(true);
      }

      setVersionChecked(true);
    } catch (error) {
      console.error("Error checking app version:", error);
      setCanEnterApp(true);
      setVersionChecked(true);
    }
  };

  const handleDownload = () => {
    if (Platform.OS === "web") {
      window.location.reload();
    } else {
      // For mobile, open download link but keep modal visible
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
