const path = require("node:path");
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  session,
} = require("electron");
const {
  isAppNavigation,
  isExternalLink,
  isAllowedResource,
  isAppPermission,
} = require("./security.cjs");

// Keep the storage location stable across installer versions and CPU architectures.
app.setName("WorkFlow OS");
app.setPath("userData", path.join(app.getPath("appData"), "WorkFlow OS"));
app.enableSandbox();

const assetDirectory = path.join(__dirname, "..", "frontend", "dist-local");
const entryFile = path.join(assetDirectory, "index.html");
let mainWindow;

function openExternal(url) {
  if (isExternalLink(url)) void shell.openExternal(url).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: "#f4f7f3",
    title: "WorkFlow OS",
    icon: path.join(__dirname, "assets", "icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppNavigation(url, entryFile)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  mainWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  void mainWindow.loadFile(entryFile).catch(() => {
    dialog.showErrorBox(
      "无法打开 WorkFlow OS",
      "安装文件不完整。请重新下载并安装应用；电脑上的工作数据会保留。",
    );
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, permission, callback, details) =>
        callback(isAppPermission(permission, details, entryFile)),
    );
    session.defaultSession.setPermissionCheckHandler(
      (_webContents, permission, _origin, details) =>
        isAppPermission(permission, details, entryFile),
    );
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel: !isAllowedResource(
          details.url,
          assetDirectory,
          details.resourceType,
        ),
      });
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin"
          ? [
              {
                label: "WorkFlow OS",
                submenu: [
                  { role: "about" },
                  { type: "separator" },
                  { role: "hide" },
                  { role: "quit" },
                ],
              },
            ]
          : []),
        {
          label: "编辑",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "查看",
          submenu: [
            { role: "reload" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "togglefullscreen" },
          ],
        },
      ]),
    );
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
