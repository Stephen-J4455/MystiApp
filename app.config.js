// Vercel exposes APP_ENV during the web build. Pass it into Expo's runtime
// config so env.js can read it on web without using EXPO_PUBLIC_*.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    appEnv: process.env.APP_ENV,
    paystackPublicKey: process.env.EXPO_PUBLIC_PAYSTACK_PUBLIC_KEY,
  },
});
