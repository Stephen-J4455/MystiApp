// Vercel exposes APP_ENV during the web build. Pass it into Expo's runtime
// config so env.js can read it on web without using EXPO_PUBLIC_*.
//
// No Paystack public key is forwarded here. Paystack keys live only in edge
// function secrets and are fetched at runtime from the `health` function, so
// that APP_ENV=development resolves the test key automatically.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    appEnv: process.env.APP_ENV,
  },
});
