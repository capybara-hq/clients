// The main process entry: wiring only. Every module it calls takes its Electron objects as
// parameters and is tested without Electron; the casts below adapt Electron's overloaded types to
// those narrow interfaces.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
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
import { brand } from "../../brand.ts";
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
import { createDeepLinkRouter, type DeepLinkApp, installDeepLinks } from "./deep-links.ts";
import { createShellBridge, type IpcMainLike } from "./ipc.ts";
import { createProfileStore, partitionFor } from "./profiles.ts";
import type { WebRequestSession } from "./request-guard.ts";
import { ADDRESS_PARTITION, hardenAnyContents, type PermissionSession } from "./security.ts";
import { createSignIn, type FetchLike } from "./sign-in.ts";
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

  // Before `ready`: a macOS `open-url` that launched the app must not be lost; links wait in a
  // queue until the router exists. A development run registers the interpreter and the app path.
  const links = installDeepLinks(app as unknown as DeepLinkApp, {
    scheme: brand.scheme,
    argv: process.argv,
    ...(process.defaultApp && process.argv[1]
      ? { defaultApp: { execPath: process.execPath, args: [resolve(process.argv[1])] } }
      : {}),
  });

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
      sessionFor: (partition) =>
        session.fromPartition(partition) as unknown as PermissionSession & WebRequestSession,
      preloadPath: join(dist, "preload", "index.cjs"),
      addressPreloadPath: join(dist, "preload", "address.cjs"),
      platform,
      openExternal: (url) => shell.openExternal(url),
      describe: (profile) => bridge.describe(profile),
      onFocusProfile: (profile) => profiles.setLastUsed(profile.id),
      onAddressClosed: (id) => addressHost.forget(id),
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
    bridge.registerCapability(SHELL_CAPABILITY_KEYS.chrome, createChromeCapability());
    // signIn@1 needs a user activation but confirms nothing natively (spec §8).
    const signIn = createSignIn({
      openExternal: (url) => shell.openExternal(url),
      // The partition's own fetch: the kernel's Set-Cookie lands in the profile's cookie jar.
      fetchFor: (profile) => {
        const ses = session.fromPartition(partitionFor(profile.id));
        return ses.fetch.bind(ses) as unknown as FetchLike;
      },
      getProfile: (id) => profiles.get(id),
      onSignedIn: (profile) => windows.reloadProfile(profile),
      machineName: hostname(),
      appVersion: shellVersion,
      log: (message, err) => console.error(message, err ?? ""),
    });
    bridge.registerCapability(SHELL_CAPABILITY_KEYS.signIn, signIn.capability, {
      activation: ["start"],
    });
    // device@1 (Task 18, with `available` and windows.broadcastChange) plugs in here.

    bridge.install(ipcMain as unknown as IpcMainLike);
    const addressHost = createAddressHost({
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
    });
    addressHost.install(ipcMain as unknown as IpcMainLike);

    const openDefault = () => {
      const last = profiles.lastUsed();
      if (last) windows.showProfile(last);
      else windows.openAddressWindow();
    };

    const router = createDeepLinkRouter({
      onAuth: (cb) => signIn.handleCallback(cb),
      // connect / open: Task 15 adds onConnect and onOpen; until then those links do nothing.
      log: (message, err) => console.error(message, err ?? ""),
    });
    links.ready((url) => router.routeDeepLink(url));

    // A second launch: a deep link in its arguments (Windows, Linux) is routed; otherwise the
    // last window comes forward. On macOS links arrive through `open-url` instead.
    app.on("second-instance", (_event, argv) => {
      if (links.fromSecondInstance(argv)) return;
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
