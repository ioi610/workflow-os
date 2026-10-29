const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  CONTENT_SECURITY_POLICY,
  isBundledResource,
  isAppNavigation,
  isExternalLink,
  isAllowedResource,
  isAppPermission,
} = require("./security.cjs");

const directory = path.resolve("fixture/dist-local");
const entry = path.join(directory, "index.html");
const entryURL = pathToFileURL(entry).href;

test("allows local bundled resources while rejecting file traversal and remote script sources", () => {
  assert.equal(
    isBundledResource(
      pathToFileURL(path.join(directory, "assets", "index.js")).href,
      directory,
    ),
    true,
  );
  for (const url of [
    pathToFileURL(path.resolve("fixture/secret.txt")).href,
    `${entryURL}/../../secret.txt`,
    "file://server/share/file.js",
    "https://example.com/app.js",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(isBundledResource(url, directory), false, url);
  }
});

test("only the application HTML can navigate; hash routes stay usable", () => {
  for (const route of [
    "",
    "#/",
    "#/workflows/example",
    "#/workflows/example/edit?detailId=sample",
  ]) {
    assert.equal(isAppNavigation(entryURL + route, entry), true);
  }
  for (const url of [
    entryURL + "?script=remote",
    pathToFileURL(path.join(directory, "assets", "other.html")).href,
    "about:blank",
    "https://example.com",
    "file:///etc/passwd",
  ]) {
    assert.equal(isAppNavigation(url, entry), false, url);
  }
});

test("only uncredentialed HTTPS links can open in the system browser", () => {
  assert.equal(isExternalLink("https://github.com/ioi610/workflow-os"), true);
  for (const url of [
    "http://example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:password@example.com",
    "mailto:person@example.com",
    "bad input",
  ]) {
    assert.equal(isExternalLink(url), false, url);
  }
});

test("offline media stays usable and executable network requests are blocked", () => {
  for (const url of [
    entryURL,
    "blob:file:///sample-media",
    "data:image/png;base64,AAAA",
    "about:blank",
  ]) {
    assert.equal(isAllowedResource(url, directory), true);
  }
  for (const url of [
    "https://example.com",
    "http://127.0.0.1:8080/api",
    "wss://example.com/socket",
    "file:///etc/passwd",
  ]) {
    assert.equal(isAllowedResource(url, directory), false);
  }
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-eval/);
});

test("existing HTTPS pictures and direct videos work without allowing remote scripts or frames", () => {
  for (const type of ["image", "media"]) {
    assert.equal(
      isAllowedResource("https://example.com/user-media", directory, type),
      true,
    );
    assert.equal(
      isAllowedResource("http://example.com/user-media", directory, type),
      false,
    );
    assert.equal(
      isAllowedResource(
        "https://user:password@example.com/user-media",
        directory,
        type,
      ),
      false,
    );
  }
  for (const type of [
    "script",
    "xhr",
    "mainFrame",
    "subFrame",
    "webSocket",
    "stylesheet",
    "font",
  ]) {
    assert.equal(
      isAllowedResource("https://example.com/resource", directory, type),
      false,
    );
  }
  assert.match(CONTENT_SECURITY_POLICY, /img-src 'self' data: blob: https:/);
  assert.match(CONTENT_SECURITY_POLICY, /media-src 'self' blob: https:/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src 'none'/);
});

test("the local main frame may copy text and persist its data but cannot read clipboard or hardware", () => {
  const details = {
    isMainFrame: true,
    requestingUrl: entryURL + "#/workflows/one",
  };
  assert.equal(
    isAppPermission("clipboard-sanitized-write", details, entry),
    true,
  );
  assert.equal(isAppPermission("persistent-storage", details, entry), true);
  for (const permission of [
    "clipboard-read",
    "fileSystem",
    "media",
    "geolocation",
    "notifications",
  ]) {
    assert.equal(isAppPermission(permission, details, entry), false);
  }
  assert.equal(
    isAppPermission(
      "clipboard-sanitized-write",
      { ...details, isMainFrame: false },
      entry,
    ),
    false,
  );
  assert.equal(
    isAppPermission(
      "clipboard-sanitized-write",
      { ...details, requestingUrl: "https://example.com" },
      entry,
    ),
    false,
  );
  assert.equal(
    isAppPermission("clipboard-sanitized-write", undefined, entry),
    false,
  );
});
