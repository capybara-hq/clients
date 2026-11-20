import type { CapacitorConfig } from "@capacitor/cli";
import { brand } from "./brand.ts";

// Capacitor's own WebView shows only the app's local pages (dist/local): no `server.url`, no
// `server.allowNavigation`. Deployments load in profile WebViews the app creates itself.
const config: CapacitorConfig = {
  appId: brand.appId,
  appName: brand.productName,
  webDir: "dist/local",
  plugins: {
    // Off: CapacitorCookies rewrites the default Android profile's cookies on Activity start and
    // destroy, and CapacitorHttp patches fetch / XHR. The app needs neither.
    CapacitorCookies: { enabled: false },
    CapacitorHttp: { enabled: false },
  },
};

export default config;
