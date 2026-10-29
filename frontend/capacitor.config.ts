import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.workflowos.personal",
  appName: "WorkFlow OS",
  webDir: "dist-local",
  backgroundColor: "#f5f4ef",
  loggingBehavior: "debug",
  android: {
    path: "../mobile/android",
    backgroundColor: "#f5f4ef",
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    minWebViewVersion: 107,
  },
  server: {
    hostname: "localhost",
    androidScheme: "https",
    cleartext: false,
    allowNavigation: [],
  },
};

export default config;
