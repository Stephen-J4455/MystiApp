const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withOptionalPortrait(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const features = (manifest['uses-feature'] ??= []);
    const name = 'android.hardware.screen.portrait';
    const portrait = features.find((feature) => feature.$['android:name'] === name);

    if (portrait) {
      portrait.$['android:required'] = 'false';
    } else {
      features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    }

    return config;
  });
};
