const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const { checkDesktopPackage } = require("./check-package.cjs");

async function fixture(extraFile) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "workflow-package-check-"),
  );
  const source = path.join(temporary, "source");
  await fs.mkdir(path.join(source, "frontend/dist-local/assets"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(source, "frontend/dist-local/index.html"),
    '<html><head><meta http-equiv="Content-Security-Policy" content="connect-src \'none\'"/></head><body><script type="module" src="./assets/app.js"></script></body></html>',
  );
  await fs.writeFile(
    path.join(source, "frontend/dist-local/assets/app.js"),
    "console.log('fixture');",
  );
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ main: "desktop/main.cjs" }),
  );
  if (extraFile)
    await fs.writeFile(path.join(source, extraFile), "fixture only");
  const archive = path.join(temporary, "app.asar");
  await asar.createPackage(source, archive);
  return { temporary, archive };
}

test("checks the actual packaged HTML and its bundled entry script", async () => {
  const { temporary, archive } = await fixture();
  try {
    assert.ok(checkDesktopPackage(archive) > 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("rejects a private configuration accidentally added to a package", async () => {
  const { temporary, archive } = await fixture(".env.local");
  try {
    assert.throws(
      () => checkDesktopPackage(archive),
      /Unexpected private or runtime file/,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
