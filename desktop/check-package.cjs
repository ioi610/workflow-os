const assert = require("node:assert/strict");
const path = require("node:path");
const asar = require("@electron/asar");

function checkDesktopPackage(archivePath) {
  const entries = asar.listPackage(archivePath);
  const fixed = new Set([
    "/desktop",
    "/desktop/assets",
    "/desktop/assets/icon.png",
    "/desktop/main.cjs",
    "/desktop/security.cjs",
    "/frontend",
    "/frontend/dist-local",
    "/package.json",
  ]);
  for (const entry of entries) {
    assert.ok(
      fixed.has(entry) || entry.startsWith("/frontend/dist-local/"),
      `Unexpected private or runtime file in the desktop package: ${entry}`,
    );
  }
  const html = asar
    .extractFile(archivePath, "frontend/dist-local/index.html")
    .toString("utf8");
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /\b(?:src|href)=["']\/(?!\/)/);
  const scripts = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)];
  assert.ok(
    scripts.length > 0,
    "The package must contain its application script.",
  );
  for (const [, script] of scripts) {
    assert.ok(
      script.startsWith("./"),
      "Packaged scripts must use local relative URLs.",
    );
    assert.ok(
      entries.includes(`/frontend/dist-local/${script.slice(2)}`),
      "The packaged application script must exist.",
    );
  }
  const metadata = JSON.parse(
    asar.extractFile(archivePath, "package.json").toString("utf8"),
  );
  assert.equal(metadata.main, "desktop/main.cjs");
  return entries.length;
}

async function afterPack(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  const count = checkDesktopPackage(path.join(resources, "app.asar"));
  console.log(
    `Verified the packaged desktop entry and ${count} public application paths.`,
  );
}

module.exports = { checkDesktopPackage, afterPack };
