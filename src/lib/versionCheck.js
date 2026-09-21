const parseVersion = (value) => {
  if (typeof value !== "string") return [0, 0, 0];

  const normalized = value.trim().replace(/^v/i, "");
  const parts = normalized.split(".").map((part) => {
    const match = String(part).match(/\d+/);
    return match ? Number(match[0]) : 0;
  });

  while (parts.length < 3) {
    parts.push(0);
  }

  return parts.slice(0, 3);
};

const compareVersions = (left, right) => {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    if (leftVersion[index] > rightVersion[index]) return 1;
    if (leftVersion[index] < rightVersion[index]) return -1;
  }

  return 0;
};

const getVersionStatus = (currentVersion, latestVersion, minimumVersion) => {
  const needsUpdate = compareVersions(currentVersion, latestVersion) < 0;
  const isBelowMinimum =
    minimumVersion &&
    minimumVersion.trim() &&
    compareVersions(currentVersion, minimumVersion) < 0;

  return {
    needsUpdate,
    isBelowMinimum: Boolean(isBelowMinimum),
  };
};

module.exports = {
  parseVersion,
  compareVersions,
  getVersionStatus,
};
