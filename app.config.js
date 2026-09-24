// The app uses APP_ENV directly for edge-function name resolution.
// This bridge also exposes the value in the Expo config for tooling.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    appEnv: process.env.APP_ENV || "development",
  },
});
