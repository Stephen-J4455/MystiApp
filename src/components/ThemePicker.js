import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../contexts/ThemeContext";
import { useThemedStyles } from "./ui";
import { fonts } from "./theme";

const OPTIONS = [
  { key: "system", label: "System", icon: "phone-portrait-outline" },
  { key: "light", label: "Light", icon: "sunny-outline" },
  { key: "dark", label: "Dark", icon: "moon-outline" },
];

/**
 * System / Light / Dark selector.
 *
 * "System" stays visibly selected after the OS flips scheme, because the
 * stored preference is tracked separately from the resolved scheme.
 */
export default function ThemePicker() {
  const { c, preference, setPreference, isDark } = useTheme();
  const { styles } = useThemedStyles();

  return (
    <View>
      <Text style={styles.label}>Appearance</Text>
      <View style={s.row}>
        {OPTIONS.map((opt) => {
          const selected = preference === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[
                s.option,
                {
                  backgroundColor: selected ? `${c.mint}1F` : c.surface,
                  borderColor: selected ? c.mintDim : c.hairline,
                },
              ]}
              onPress={() => setPreference(opt.key)}
              activeOpacity={0.8}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
            >
              <Ionicons
                name={opt.icon}
                size={17}
                color={selected ? c.mint : c.textMuted}
              />
              <Text
                style={[
                  s.optionLabel,
                  { color: selected ? c.textPrimary : c.textMuted },
                ]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[s.hint, { color: c.textMuted }]}>
        {preference === "system"
          ? `Following your device (${isDark ? "dark" : "light"}).`
          : `Always ${preference}.`}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 8,
  },
  option: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
  },
  optionLabel: {
    fontFamily: fonts.bodySemi,
    fontSize: 12,
  },
  hint: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    marginTop: 9,
  },
});
