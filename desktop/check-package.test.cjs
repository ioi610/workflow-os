const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
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

async function windowsPackageChecker() {
  const source = await fs.readFile(
    path.join(__dirname, "check-package.cjs"),
    "utf8",
  );
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    console,
    require(name) {
      if (name === "node:path") return path.win32;
      if (name === "@electron/asar")
        return {
          ...asar,
          listPackage: (archive) =>
            asar
              .listPackage(archive)
              .map((entry) => entry.replaceAll("/", "\\")),
          extractFile: (archive, filename) => {
            assert.equal(
              filename,
              path.win32.normalize(filename),
              "ASAR needs host-native separators when looking up entries.",
            );
            return asar.extractFile(archive, filename.replaceAll("\\", "/"));
          },
        };
      return require(name);
    },
  });
  return module.exports.checkDesktopPackage;
}

test("accepts the Windows ASAR separator format while retaining script existence checks", async () => {
  const { temporary, archive } = await fixture();
  try {
    assert.ok((await windowsPackageChecker())(archive) > 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Windows ASAR normalization still rejects private configuration", async () => {
  const { temporary, archive } = await fixture(".env.local");
  const checker = await windowsPackageChecker();
  try {
    assert.throws(() => checker(archive), /Unexpected private or runtime file/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
