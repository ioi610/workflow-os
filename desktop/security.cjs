const path = require("node:path");
const { fileURLToPath } = require("node:url");

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' blob: https:",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function isInsideDirectory(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function isBundledResource(rawURL, assetDirectory) {
  try {
    const url = new URL(rawURL);
    if (url.protocol !== "file:" || url.host || url.username || url.password)
      return false;
    return isInsideDirectory(fileURLToPath(url), assetDirectory);
  } catch {
    return false;
  }
}

function isAppNavigation(rawURL, entryFile) {
  try {
    const url = new URL(rawURL);
    return (
      url.protocol === "file:" &&
      !url.host &&
      !url.search &&
      fileURLToPath(url) === entryFile
    );
  } catch {
    return false;
  }
}

function isExternalLink(rawURL) {
  try {
    const url = new URL(rawURL);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isAllowedResource(rawURL, assetDirectory, resourceType) {
  if (isBundledResource(rawURL, assetDirectory)) return true;
  if (["image", "media"].includes(resourceType) && isExternalLink(rawURL))
    return true;
  try {
    return ["data:", "blob:", "about:"].includes(new URL(rawURL).protocol);
  } catch {
    return false;
  }
}

function isAppPermission(permission, details, entryFile) {
  return (
    ["clipboard-sanitized-write", "persistent-storage"].includes(permission) &&
    details?.isMainFrame === true &&
    isAppNavigation(details.requestingUrl, entryFile)
  );
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  isBundledResource,
  isAppNavigation,
  isExternalLink,
  isAllowedResource,
  isAppPermission,
};
