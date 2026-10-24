export const getProviderDisplayName = (provider) => {
  const key = String(provider || "jehuca").trim().toLowerCase();
  if (key === "jehuca") return "Mys";
  if (key === "bisdel") return "Everyday";
  return "Data provider";
};
