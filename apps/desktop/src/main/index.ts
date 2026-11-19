// The main process entry: wiring only. Every module it calls takes its Electron objects as
// parameters and is tested without Electron; the casts below adapt Electron's overloaded types to
// those narrow interfaces.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import { brand } from "../../brand.ts";
import { APP_SCHEME, chromeState, platformFrom } from "../shared/protocol.ts";
import { SHELL_CAPABILITY_KEYS } from "../shared/sdk-shell-types.ts";
import { createAddressHost, discoverDeployment, localeFrom } from "./address.ts";
import { appMenuTemplate, createStartAtLogin } from "./app-menu.ts";
import { createAppProtocolHandler } from "./app-protocol.ts";
import {
  createChromeCapability,
  createNotifyCapability,
  createOpenExternalCapability,
  type NotificationClass,
} from "./capabilities.ts";
import {
  createDeepLinkHandlers,
  createDeepLinkRouter,
  type DeepLinkApp,
  installDeepLinks,
} from "./deep-links.ts";
import { createDockIcon, createDockIconCache, type DockCacheFs } from "./dock.ts";
import { createShellBridge, type IpcMainLike } from "./ipc.ts";
import {
  createPlistReader,
  ensureManagedProfiles,
  isAddressAllowed,
  readManagedConfig,
} from "./managed.ts";
import { createProfileStore, type Profile, partitionFor } from "./profiles.ts";
import type { WebRequestSession } from "./request-guard.ts";
import { ADDRESS_PARTITION, hardenAnyContents, type PermissionSession } from "./security.ts";
import { createSignIn, type FetchLike } from "./sign-in.ts";
import { createTrayController, type TrayLike } from "./tray.ts";
import { setupUpdates } from "./updates.ts";
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
    // Managed preferences (MDM): read once at start; a missing or malformed file is `{}`.
    const managed = readManagedConfig({
      appId: brand.appId,
      user: userInfo().username,
      readPlist: createPlistReader({ existsSync: fs.existsSync, execFileSync }),
    });

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
      onFocusProfile: (profile) => {
        profiles.setLastUsed(profile.id);
        refreshUi();
      },
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
      isAllowed: (address) => isAddressAllowed(managed, address),
      addProfile: (candidate) => {
        const profile = profiles.add(candidate);
        refreshUi();
        return profile;
      },
      openProfile: (profile) => {
        profiles.setLastUsed(profile.id);
        windows.showProfile(profile);
      },
      closeSender: (sender) => windows.closeSender(sender),
    });
    addressHost.install(ipcMain as unknown as IpcMainLike);

    // Under `lockDeployments` the app offers only the managed profiles (an older saved one stays
    // on disk but is not offered).
    const visibleProfiles = (): Profile[] =>
      managed.lockDeployments === true
        ? profiles.list().filter((p) => isAddressAllowed(managed, p.base))
        : profiles.list();

    const openDefault = () => {
      const visible = visibleProfiles();
      const last = profiles.lastUsed();
      const target = last && visible.some((p) => p.id === last.id) ? last : visible[0];
      if (target) windows.showProfile(target);
      // First launch of a managed install: the address page, with the first managed address ready.
      else windows.openAddressWindow(managed.profiles?.[0]);
    };

    // Tray, app menu and Dock icon: one refresh after anything that changes the profiles.
    const startAtLogin = createStartAtLogin(app);
    const locale = localeFrom(app.getLocale());
    const uiActions = {
      showProfile: (id: string) => {
        const profile = profiles.get(id);
        if (!profile) return;
        profiles.setLastUsed(id);
        windows.showProfile(profile);
        refreshUi();
      },
      addPlatform: () => {
        windows.openAddressWindow();
      },
      openWindow: () => {
        if (!windows.focusLast()) openDefault();
      },
      quit: () => app.quit(),
      setStartAtLogin: (on: boolean) => {
        startAtLogin.set(on);
        refreshUi();
      },
    };
    const iconFile = (name: string) => join(app.getAppPath(), brand.icons, name);
    const trayIcon = () => {
      const file = iconFile("trayTemplate.png");
      if (!fs.existsSync(file)) return { image: nativeImage.createEmpty(), found: false };
      const image = nativeImage.createFromPath(file);
      image.setTemplateImage(true);
      return { image, found: true };
    };
    const tray = createTrayController({
      createTray: () => new Tray(trayIcon().image) as unknown as TrayLike,
      buildMenu: (template) => Menu.buildFromTemplate(template as unknown as never),
      tooltip: brand.productName,
      // Until the tray icon asset exists, the tray shows the name instead of an invisible image.
      ...(trayIcon().found ? {} : { fallbackTitle: brand.productName }),
      actions: uiActions,
    });
    const dockIcon = createDockIcon({
      fetch: net.fetch as typeof fetch,
      setIcon: (png) => {
        const image = nativeImage.createFromBuffer(Buffer.from(png));
        if (image.isEmpty()) throw new Error("the Dock icon could not be decoded");
        app.dock?.setIcon(image);
      },
      restoreDefault: () => {
        const file = iconFile("icon.png");
        if (fs.existsSync(file)) app.dock?.setIcon(nativeImage.createFromPath(file));
      },
      ...createDockIconCache(join(app.getPath("userData"), "dock-icons"), fs as DockCacheFs),
      log: (message, err) => console.error(message, err ?? ""),
    });
    function refreshUi(): void {
      const visible = visibleProfiles();
      const state = {
        locale,
        profiles: visible.map((p) => ({ id: p.id, name: p.name })),
        activeId: profiles.lastUsed()?.id,
        lockDeployments: managed.lockDeployments === true,
      };
      tray.update(state);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          appMenuTemplate(
            {
              ...state,
              productName: brand.productName,
              startAtLogin: startAtLogin.enabled(),
            },
            uiActions,
          ) as unknown as never,
        ),
      );
      void dockIcon.update(visible);
    }

    // `connect` only prefills the address page; `open` only focuses an existing profile.
    const deepLinkHandlers = createDeepLinkHandlers({
      profiles: visibleProfiles,
      isAllowedAddress: (address) => isAddressAllowed(managed, address),
      openAddress: (prefill) => {
        windows.openAddressWindow(prefill);
      },
      showProfile: (profile, url) => {
        profiles.setLastUsed(profile.id);
        windows.showProfile(profile, url);
      },
    });

    const router = createDeepLinkRouter({
      onAuth: (cb) => signIn.handleCallback(cb),
      ...deepLinkHandlers,
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

    refreshUi();
    openDefault();

    // Managed profiles (spec §6.4) are ensured lazily and never block the start: each one that is
    // not saved yet is discovered like an address typed on the address page and saved when it
    // answers; one that does not answer is tried again at the next launch.
    void ensureManagedProfiles(managed.profiles ?? [], {
      has: (base) => profiles.list().some((p) => p.base === base),
      discover: (base) => discoverDeployment(base, { fetch: net.fetch as typeof fetch }),
      add: (candidate) => profiles.add(candidate),
    }).then((added) => {
      if (added > 0) refreshUi();
    });

    // electron-updater works only in a packaged app. `afterUpdate` is Task 17's hook (device
    // `service restart` when the bundled device changed).
    if (app.isPackaged) {
      const updates = setupUpdates({
        autoUpdater,
        managed,
        logger: { info: console.info, error: console.error },
        afterUpdate: async () => {},
      });
      void updates.check();
    }
  });
}
