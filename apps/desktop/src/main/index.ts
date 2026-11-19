// The main process entry: wiring only. Every module it calls takes its Electron objects as
// parameters and is tested without Electron; the casts below adapt Electron's overloaded types to
// those narrow interfaces.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { SHELL_CAPABILITY_KEYS } from "@capybara-hq/plugin-sdk";
import { fetchMeta } from "@capybara-hq/shell";
import {
  app,
  BrowserWindow,
  dialog,
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
import { CHROME_CAPABILITY_KEY } from "../shared/chrome-capability.ts";
import { APP_SCHEME, chromeState, platformFrom } from "../shared/protocol.ts";
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
import { createDeviceAvailability } from "./device/availability.ts";
import { createDeviceCapability, type DeviceCapability } from "./device/capability.ts";
import { createDeviceCli, type SpawnLike } from "./device/cli.ts";
import { controlClient, deviceStateDir } from "./device/control.ts";
import { createDeviceDialogs, type MessageBoxOptions } from "./device/dialogs.ts";
import { readKeepAwake, readMachine } from "./device/machine.ts";
import { createDeviceService } from "./device/service.ts";
import { createDeviceTexts } from "./device/texts.ts";
import { createTrayDevice } from "./device/tray-device.ts";
import { createDockIcon, createDockIconCache, type DockCacheFs } from "./dock.ts";
import { createConfirmGate, createShellBridge, type IpcMainLike } from "./ipc.ts";
import {
  createPlistReader,
  ensureManagedProfiles,
  isAddressAllowed,
  readManagedConfig,
} from "./managed.ts";
import { createProfileStore, type Profile, partitionFor } from "./profiles.ts";
import { ADDRESS_PARTITION, hardenAnyContents } from "./security.ts";
import { createSignIn, type FetchLike } from "./sign-in.ts";
import { createTrayController, type TrayLike } from "./tray.ts";
import { createUiRefresh } from "./ui-refresh.ts";
import { setupUpdates } from "./updates.ts";
import { desktopUserAgent } from "./user-agent.ts";
import {
  createWindowManager,
  type ProfileSession,
  type ProfileTarget,
  type WindowLike,
} from "./windows.ts";

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

    // The device login service (spec §5.2) runs the bundled Node and device from Resources (a
    // development run: apps/desktop/build, filled by scripts/bundle-node.ts). Installing it is
    // connecting (device@1 below); at start a packaged app only repairs an installed service whose
    // app moved, then restarts it if an update replaced the bundled device it runs.
    const resourcesPath = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");
    const deviceCli = createDeviceCli({
      resourcesPath,
      spawn: spawn as unknown as SpawnLike,
      env: process.env,
      log: (message, err) => console.error(message, err ?? ""),
    });
    // Quitting ends the UI only (spec §9.4): the service keeps running; a CLI command still
    // running for the app is ended with it.
    app.on("will-quit", () => deviceCli.dispose());
    // `env`: `service install` records a PATH that also finds docker (launchd's is short).
    const deviceService = createDeviceService({ cli: deviceCli, resourcesPath, env: process.env });
    // Set once device@1 exists; a profile removed before that has nothing to ask.
    let device: DeviceCapability | undefined;

    const profiles = createProfileStore({
      file: join(app.getPath("userData"), "profiles.json"),
      fs,
      sessionFor: (partition) => session.fromPartition(partition),
      newId: () => randomUUID(),
      // Spec §6.3: connected to that deployment → ask whether to disconnect and log out too.
      beforeRemove: async (profile) => {
        await device?.beforeRemoveProfile(profile, null);
      },
      log: (message, err) => console.error(message, err ?? ""),
    });

    // One native dialog at a time per profile, for a page's call and the tray's click alike.
    const confirmGate = createConfirmGate();
    const control = controlClient(deviceStateDir(process.env, homedir()));
    const bridge = createShellBridge<ProfileTarget>({
      gate: confirmGate,
      resolveSender: (sender) => windows.resolveSender(sender),
      stateFor: (target) => chromeState(platform, target.window.isFullScreen()),
      platform,
      shellVersion,
      sendEvent: (target, message) => windows.sendEvent(target, message),
    });

    // `managed` is read once at start (no re-read path exists yet); a re-read would have to call
    // `evaluate` again for every profile so a changed `connectThisMachine` takes effect.
    const deviceAvailability = createDeviceAvailability({
      platform: process.platform,
      managed,
      fetchMeta: (base) => fetchMeta(base, net.fetch as typeof fetch),
      onChange: (profileId) => {
        // A capability no longer offered keeps no subscriptions.
        bridge.pruneSubscriptions();
        windows.broadcastChange(profileId);
      },
      log: (message, err) => console.error(message, err ?? ""),
    });

    const windows = createWindowManager({
      createWindow: (options) =>
        // `parent` is typed unknown in the window module: it is always a BrowserWindow here.
        new BrowserWindow(
          options as unknown as ConstructorParameters<typeof BrowserWindow>[0],
        ) as unknown as WindowLike,
      sessionFor: (partition) => session.fromPartition(partition) as unknown as ProfileSession,
      preloadPath: join(dist, "preload", "index.cjs"),
      addressPreloadPath: join(dist, "preload", "address.cjs"),
      platform,
      openExternal: (url) => shell.openExternal(url),
      describe: (profile) => bridge.describe(profile),
      describeEvents: (profile) => bridge.describeEvents(profile),
      // Each load of a deployment window asks its discovery again whether device@1 is offered.
      onProfileLoad: (profile) => void deviceAvailability.evaluate(profile),
      onProfileClosed: (id) => bridge.dropSubscriptions(id),
      onFocusProfile: (profile) => {
        profiles.setLastUsed(profile.id);
        ui.stateChanged();
      },
      onAddressClosed: (id) => addressHost.forget(id),
      // Only to each profile's own origin; the token exchange sets the same value itself.
      userAgent: desktopUserAgent(shellVersion, hostname()),
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
    bridge.registerCapability(CHROME_CAPABILITY_KEY, createChromeCapability());
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
    // device@1 (spec §8, §9): native confirmations attached to the calling window.
    device = createDeviceCapability({
      cli: deviceCli,
      service: deviceService,
      control,
      dialogs: createDeviceDialogs({
        showMessageBox: (parent, options: MessageBoxOptions) =>
          parent instanceof BrowserWindow && !parent.isDestroyed()
            ? dialog.showMessageBox(parent, options)
            : dialog.showMessageBox(options),
        locale: localeFrom(app.getLocale()),
        platform: process.platform,
      }),
      texts: createDeviceTexts({
        resourcesPath,
        spawn: spawn as unknown as SpawnLike,
        env: process.env,
      }),
      openVerification: (target, url) =>
        windows.openChildWindow(target.profile, target.window, url),
      log: (message, err) => console.error(message, err ?? ""),
    });
    bridge.registerCapability(SHELL_CAPABILITY_KEYS.device, device.impl, {
      confirming: device.confirming,
      events: device.events,
      available: (profile) => deviceAvailability.isAvailable(profile),
    });

    bridge.install(ipcMain as unknown as IpcMainLike);
    const addressHost = createAddressHost({
      discover: (input) => discoverDeployment(input, { fetch: net.fetch as typeof fetch }),
      isAddressSender: (sender) => windows.isAddressSender(sender),
      locale: localeFrom(app.getLocale()),
      prefillFor: (sender) => windows.prefillFor(sender),
      isAllowed: (address) => isAddressAllowed(managed, address),
      addProfile: (candidate) => {
        const profile = profiles.add(candidate);
        ui.profilesChanged();
        trayDevice.refresh();
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
    const isVisible = (p: Profile): boolean =>
      managed.lockDeployments !== true || isAddressAllowed(managed, p.base);
    const visibleProfiles = (): Profile[] => profiles.list().filter(isVisible);

    const openDefault = () => {
      const visible = visibleProfiles();
      const last = profiles.lastUsed();
      const target = last && visible.some((p) => p.id === last.id) ? last : visible[0];
      if (target) windows.showProfile(target);
      // First launch of a managed install: the address page, with the first managed address ready.
      else windows.openAddressWindow(managed.profiles?.[0]);
    };

    // This machine's device in the tray (spec §9.6). Its actions are device@1's own functions.
    const trayDevice = createTrayDevice({
      control,
      readMachine: () => readMachine(deviceCli),
      readKeepAwake: () => readKeepAwake(deviceCli),
      profiles: visibleProfiles,
      impl: device.impl,
      gate: confirmGate,
      openDevicePage: (profile, path) => windows.showProfile(profile, profile.base + path),
      onChange: () => ui.stateChanged(),
      log: (message, err) => console.error(message, err ?? ""),
    });
    // Quitting ends the UI only: the tray's subscription ends, the service keeps running.
    app.on("will-quit", () => trayDevice.dispose());

    // Tray, app menu and Dock icon: one refresh after anything that changes the profiles.
    const startAtLogin = createStartAtLogin(app);
    const locale = localeFrom(app.getLocale());
    const uiActions = {
      showProfile: (id: string) => {
        const profile = visibleProfiles().find((p) => p.id === id);
        if (!profile) return;
        profiles.setLastUsed(id);
        windows.showProfile(profile);
        ui.stateChanged();
      },
      addPlatform: () => {
        windows.openAddressWindow();
      },
      openWindow: () => {
        if (!windows.focusLast(isVisible)) openDefault();
      },
      // Never asks and never stops the service (spec §9.4).
      quit: () => app.quit(),
      device: trayDevice.actions,
      setStartAtLogin: (on: boolean) => {
        startAtLogin.set(on);
        ui.stateChanged();
      },
    };
    const iconFile = (name: string) => join(app.getAppPath(), brand.icons, name);
    // trayTemplate.png and trayTemplate@2x.png: macOS picks the @2x by itself.
    const trayIcon = (() => {
      const file = iconFile("trayTemplate.png");
      if (!fs.existsSync(file)) return { image: nativeImage.createEmpty(), found: false };
      const image = nativeImage.createFromPath(file);
      image.setTemplateImage(true);
      return { image, found: true };
    })();
    const tray = createTrayController({
      createTray: () => new Tray(trayIcon.image) as unknown as TrayLike,
      buildMenu: (template) => Menu.buildFromTemplate(template as unknown as never),
      tooltip: brand.productName,
      // Without the tray icon file the tray shows the name instead of an invisible image.
      ...(trayIcon.found ? {} : { fallbackTitle: brand.productName }),
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
    function render(): void {
      const visible = visibleProfiles();
      const state = {
        locale,
        profiles: visible.map((p) => ({ id: p.id, name: p.name })),
        activeId: profiles.lastUsed()?.id,
        lockDeployments: managed.lockDeployments === true,
        device: trayDevice.current(),
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
    }
    const ui = createUiRefresh({
      render,
      updateDock: () => dockIcon.update(visibleProfiles()),
      log: (message, err) => console.error(message, err ?? ""),
    });

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
      if (!windows.focusLast(isVisible)) openDefault();
    });

    app.on("activate", () => {
      if (!windows.hasWindows()) openDefault();
    });

    app.on("window-all-closed", () => {
      if (platform !== "macos") app.quit();
    });

    ui.profilesChanged();
    trayDevice.start();
    openDefault();

    // Managed profiles (spec §6.4) are ensured lazily and never block the start: each one that is
    // not saved yet is discovered like an address typed on the address page and saved when it
    // answers; one that does not answer is tried again at the next launch.
    void ensureManagedProfiles(managed.profiles ?? [], {
      has: (base) => profiles.list().some((p) => p.base === base),
      discover: (base) => discoverDeployment(base, { fetch: net.fetch as typeof fetch }),
      add: (candidate) => profiles.add(candidate),
    }).then((added) => {
      if (added > 0) {
        ui.profilesChanged();
        trayDevice.refresh();
      }
    });

    // electron-updater works only in a packaged app. An update installs on quit, so the
    // `afterUpdate` call at the next start is the one that finds the new device on disk.
    if (app.isPackaged) {
      void deviceService
        .repairService()
        .then(() => deviceService.afterUpdate())
        .catch((err: unknown) => console.error("device service check failed", err));
      const updates = setupUpdates({
        autoUpdater,
        managed,
        logger: { info: console.info, error: console.error },
        afterUpdate: () => deviceService.afterUpdate(),
      });
      void updates.check();
    }
  });
}
