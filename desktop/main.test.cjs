const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

async function boot(hasLock = true) {
  const events = {};
  const calls = {
    windows: [],
    external: [],
    quit: 0,
    paths: {},
    permissions: {},
  };
  const defaultSession = {
    setPermissionRequestHandler(handler) {
      calls.permissions.request = handler;
    },
    setPermissionCheckHandler(handler) {
      calls.permissions.check = handler;
    },
    webRequest: {
      onBeforeRequest(handler) {
        calls.resource = handler;
      },
    },
  };
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.events = {};
      this.webEvents = {};
      this.webContents = {
        setWindowOpenHandler: (handler) => {
          this.open = handler;
        },
        on: (name, handler) => {
          this.webEvents[name] = handler;
        },
      };
      calls.windows.push(this);
    }
    once(name, handler) {
      this.events[name] = handler;
    }
    on(name, handler) {
      this.events[name] = handler;
    }
    loadFile(file) {
      this.file = file;
      return Promise.resolve();
    }
    show() {
      this.shown = true;
    }
    focus() {
      this.focused = true;
    }
    isMinimized() {
      return false;
    }
    static getAllWindows() {
      return calls.windows;
    }
  }
  const electron = {
    app: {
      isPackaged: true,
      setName(name) {
        calls.name = name;
      },
      getPath(name) {
        assert.equal(name, "appData");
        return path.resolve("fixture/app-data");
      },
      setPath(name, value) {
        calls.paths[name] = value;
      },
      enableSandbox() {
        calls.sandbox = true;
      },
      requestSingleInstanceLock() {
        return hasLock;
      },
      quit() {
        calls.quit++;
      },
      on(name, handler) {
        events[name] = handler;
      },
      whenReady() {
        return Promise.resolve();
      },
    },
    BrowserWindow,
    session: { defaultSession },
    Menu: {
      buildFromTemplate(template) {
        return template;
      },
      setApplicationMenu() {},
    },
    dialog: { showErrorBox() {} },
    shell: {
      openExternal(url) {
        calls.external.push(url);
        return Promise.resolve();
      },
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  vm.runInNewContext(source, {
    __dirname,
    process: { platform: "linux" },
    require(name) {
      return name === "electron" ? electron : require(name);
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  return { calls, events };
}

test("desktop boots the standalone file with sandboxed renderer and stable native storage", async () => {
  const { calls } = await boot();
  const window = calls.windows[0];
  assert.equal(
    window.file,
    path.resolve(__dirname, "../frontend/dist-local/index.html"),
  );
  assert.equal(
    calls.paths.userData,
    path.resolve("fixture/app-data/WorkFlow OS"),
  );
  assert.equal(calls.sandbox, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.webSecurity, true);
  assert.equal(window.options.webPreferences.webviewTag, false);
  assert.equal(window.options.webPreferences.devTools, false);
  assert.equal("preload" in window.options.webPreferences, false);
  assert.equal(calls.permissions.check(), false);
  let granted;
  calls.permissions.request({}, "camera", (result) => {
    granted = result;
  });
  assert.equal(granted, false);
});

test("remote content cannot replace the app; valid external links use system browser", async () => {
  const { calls } = await boot();
  const window = calls.windows[0];
  let prevented = false;
  window.webEvents["will-navigate"](
    {
      preventDefault() {
        prevented = true;
      },
    },
    "https://github.com/ioi610/workflow-os",
  );
  assert.equal(prevented, true);
  assert.deepEqual(calls.external, ["https://github.com/ioi610/workflow-os"]);
  assert.equal(window.open({ url: "javascript:alert(1)" }).action, "deny");
  assert.equal(calls.external.length, 1);
  prevented = false;
  window.webEvents["will-navigate"](
    {
      preventDefault() {
        prevented = true;
      },
    },
    pathToFileURL(window.file).href + "#/workflows/one",
  );
  assert.equal(prevented, false);
  let cancelled;
  calls.resource({ url: "https://example.com/script.js" }, ({ cancel }) => {
    cancelled = cancel;
  });
  assert.equal(cancelled, true);
  calls.resource(
    { url: "https://example.com/picture.png", resourceType: "image" },
    ({ cancel }) => {
      cancelled = cancel;
    },
  );
  assert.equal(cancelled, false);
  calls.resource(
    { url: "https://example.com/player", resourceType: "subFrame" },
    ({ cancel }) => {
      cancelled = cancel;
    },
  );
  assert.equal(cancelled, true);
});

test("second launch focuses the existing app and exits if another process owns the lock", async () => {
  const { calls, events } = await boot();
  events["second-instance"]();
  assert.equal(calls.windows[0].focused, true);
  assert.equal(calls.windows.length, 1);
  const blocked = await boot(false);
  assert.equal(blocked.calls.quit, 1);
  assert.equal(blocked.calls.windows.length, 0);
});

test("only application code and standalone public assets enter the package", () => {
  const config = require("./electron-builder.cjs");
  assert.deepEqual(config.files, [
    "desktop/main.cjs",
    "desktop/security.cjs",
    "desktop/assets/icon.png",
    "frontend/dist-local/**/*",
    "package.json",
  ]);
  assert.equal(config.electronFuses.runAsNode, false);
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(
    config.electronFuses.enableEmbeddedAsarIntegrityValidation,
    true,
  );
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});
