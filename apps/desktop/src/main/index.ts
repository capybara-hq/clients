// The main process entry: wiring only. Every module it calls takes its Electron objects as
// parameters and is tested without Electron; the casts below adapt Electron's overloaded types to
// those narrow interfaces.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
} from "electron";
import { APP_SCHEME, chromeState, platformFrom } from "../shared/protocol.ts";
import { SHELL_CAPABILITY_KEYS } from "../shared/sdk-shell-types.ts";
import { createAddressHost, discoverDeployment, localeFrom } from "./address.ts";
import { createAppProtocolHandler } from "./app-protocol.ts";
import {
  createChromeCapability,
  createNotifyCapability,
  createOpenExternalCapability,
  type NotificationClass,
} from "./capabilities.ts";
import { createShellBridge, type IpcMainLike } from "./ipc.ts";
import { createProfileStore } from "./profiles.ts";
import { ADDRESS_PARTITION, hardenAnyContents, type PermissionSession } from "./security.ts";
import { createWindowManager, type ProfileTarget, type WindowLike } from "./windows.ts";

// Before `ready`: app:// is a standard, secure scheme so the address page has a real origin.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  // The bundle is dist/main/index.cjs; the preloads and the address page sit next to it.
  const dist = join(__dirname, "..");
  const platform = platformFrom(process.platform);
  const shellVersion = app.getVersion();

  // Baseline for every webContents (no <webview>, no window.open) before any window-specific rules.
  app.on("web-contents-created", (_event, contents) => {
    hardenAnyContents(contents as unknown as Parameters<typeof hardenAnyContents>[0]);
  });

  app.whenReady().then(() => {
    session
      .fromPartition(ADDRESS_PARTITION)
      .protocol.handle(
        APP_SCHEME,
        createAppProtocolHandler({ dir: join(dist, "address-page"), readFile }),
      );

    const profiles = createProfileStore({
      file: join(app.getPath("userData"), "profiles.json"),
      fs,
      sessionFor: (partition) => session.fromPartition(partition),
      newId: () => randomUUID(),
    });

    const bridge = createShellBridge<ProfileTarget>({
      resolveSender: (sender) => windows.resolveSender(sender),
      stateFor: (target) => chromeState(platform, target.window.isFullScreen()),
      platform,
      shellVersion,
    });

    const windows = createWindowManager({
      createWindow: (options) => new BrowserWindow(options) as unknown as WindowLike,
      sessionFor: (partition) => session.fromPartition(partition) as unknown as PermissionSession,
      preloadPath: join(dist, "preload", "index.cjs"),
      addressPreloadPath: join(dist, "preload", "address.cjs"),
      platform,
      openExternal: (url) => shell.openExternal(url),
      describe: (profile) => bridge.describe(profile),
      onFocusProfile: (profile) => profiles.setLastUsed(profile.id),
      backgroundColor: () => (nativeTheme.shouldUseDarkColors ? "#161715" : "#f7f7f5"),
      log: (message, err) => console.error(message, err),
    });

    bridge.registerCapability(
      SHELL_CAPABILITY_KEYS.notify,
      createNotifyCapability({
        Notification: Notification as unknown as NotificationClass,
        showProfile: (profile, url) => windows.showProfile(profile, url),
      }),
    );
    bridge.registerCapability(
      SHELL_CAPABILITY_KEYS.openExternal,
      createOpenExternalCapability({ openExternal: (url) => shell.openExternal(url) }),
    );
    bridge.registerCapability("chrome@1", createChromeCapability());
    // signIn@1 (Task 14) and device@1 (Task 18, with `available` and windows.broadcastChange) plug
    // in here through bridge.registerCapability.

    bridge.install(ipcMain as unknown as IpcMainLike);
    createAddressHost({
      discover: (input) => discoverDeployment(input, { fetch: net.fetch as typeof fetch }),
      isAddressSender: (sender) => windows.isAddressSender(sender),
      locale: localeFrom(app.getLocale()),
      prefillFor: (sender) => windows.prefillFor(sender),
      addProfile: (candidate) => profiles.add(candidate),
      openProfile: (profile) => {
        profiles.setLastUsed(profile.id);
        windows.showProfile(profile);
      },
      closeSender: (sender) => windows.closeSender(sender),
    }).install(ipcMain as unknown as IpcMainLike);

    const openDefault = () => {
      const last = profiles.lastUsed();
      if (last) windows.showProfile(last);
      else windows.openAddressWindow();
    };

    // A second launch focuses the last window. Deep links (Task 14) arrive in `argv` here on
    // Windows and Linux and through `open-url` on macOS; route them before falling back to focus.
    app.on("second-instance", (_event, _argv) => {
      if (!windows.focusLast()) openDefault();
    });

    app.on("activate", () => {
      if (!windows.hasWindows()) openDefault();
    });

    app.on("window-all-closed", () => {
      if (platform !== "macos") app.quit();
    });

    openDefault();
  });
}
