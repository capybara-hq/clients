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
import { discover, fetchMeta } from "@capybara-hq/shell";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import { brand } from "../../brand.ts";
import { CHROME_CAPABILITY_KEY } from "../shared/chrome-capability.ts";
import { APP_SCHEME, chromeState, platformFrom } from "../shared/protocol.ts";
import { appMenuTemplate, createStartAtLogin } from "./app-menu.ts";
import { createAppProtocolHandler } from "./app-protocol.ts";
import {
  BUILTIN_TOKENS,
  backgroundOf,
  electronColor,
  overlayColors,
  resolveAppearance,
} from "./appearance.ts";
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
import { createDeviceCapability } from "./device/capability.ts";
import { createDeviceCli, type SpawnLike } from "./device/cli.ts";
import { controlClient, deviceStateDir } from "./device/control.ts";
import { createDeviceDialogs, dialogPlatformOf } from "./device/dialogs.ts";
import { readKeepAwake, readMachine } from "./device/machine.ts";
import { createDeviceService } from "./device/service.ts";
import { createDeviceTexts } from "./device/texts.ts";
import { createTrayDevice } from "./device/tray-device.ts";
import {
  createDockIcon,
  createDockIconCache,
  type DockCacheFs,
  fetchPlatformIcon,
  isPng,
  platformIconUrl,
  pngDataUrl,
} from "./dock.ts";
import { createConfirmGate, createShellBridge, type IpcMainLike } from "./ipc.ts";
import { createLocalPages } from "./local-pages.ts";
import {
  createPlistReader,
  ensureManagedProfiles,
  isAddressAllowed,
  readManagedConfig,
} from "./managed.ts";
import { createOnboarding, type OnboardingWindow, platformName } from "./onboarding.ts";
import { type CookieJarLike, createPreferences, installPreferenceActions } from "./preferences.ts";
import { createProfileStore, type Profile, partitionFor } from "./profiles.ts";
import { createProfileRemoval } from "./remove-profile.ts";
import { hardenAnyContents, installDenyAllPermissions, LOCAL_PARTITION } from "./security.ts";
import { createShellDialogs, type DialogWindow } from "./shell-dialog.ts";
import { createSignIn, type FetchLike, REDIRECT_URI } from "./sign-in.ts";
import {
  type CompletedSession,
  createSignOut,
  signOutOnLogin,
  watchLoginNavigations,
  watchLogout,
} from "./sign-out.ts";
import { createTrayController, type TrayLike } from "./tray.ts";
import { createUiRefresh } from "./ui-refresh.ts";
import { setupUpdates, updateNotice } from "./updates.ts";
import { desktopUserAgent, machineNameFrom } from "./user-agent.ts";
import {
  createWindowManager,
  type ProfileSession,
  type ProfileTarget,
  smallWindowControls,
  type WindowLike,
} from "./windows.ts";

// Before `ready`: app:// is a standard, secure scheme so the local pages have a real origin.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
]);

// The end-to-end test seam (apps/desktop/e2e): honoured only by an unpackaged app and only with
// this variable set. It gives the run its own userData directory (profiles, partitions, the
// single-instance lock) and keeps the run from registering the OS protocol handler; nothing else
// changes. Loopback http addresses need no seam: normalizeAddress already allows them.
const e2eUserData = !app.isPackaged ? process.env.CAPYBARA_E2E_USER_DATA : undefined;
if (e2eUserData) app.setPath("userData", e2eUserData);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  // The bundle is dist/main/index.cjs; the preloads and the local pages sit next to it.
  const dist = join(__dirname, "..");
  const platform = platformFrom(process.platform);
  const shellVersion = app.getVersion();

  // Before `ready`: a macOS `open-url` that launched the app must not be lost; links wait in a
  // queue until the router exists. A development run registers the interpreter and the app path.
  const links = installDeepLinks(
    (e2eUserData
      ? { on: app.on.bind(app), setAsDefaultProtocolClient: () => false }
      : app) as unknown as DeepLinkApp,
    {
      scheme: brand.scheme,
      argv: process.argv,
      ...(process.defaultApp && process.argv[1]
        ? { defaultApp: { execPath: process.execPath, args: [resolve(process.argv[1])] } }
        : {}),
    },
  );

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

    // Only the local partition serves app://local; no other partition has the scheme.
    const localSession = session.fromPartition(LOCAL_PARTITION);
    localSession.protocol.handle(
      APP_SCHEME,
      createAppProtocolHandler({ localDir: join(dist, "local"), readFile }),
    );
    // The local pages ask for no permission, ever.
    installDenyAllPermissions(localSession);

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
    const profiles = createProfileStore({
      file: join(app.getPath("userData"), "profiles.json"),
      fs,
      sessionFor: (partition) => session.fromPartition(partition),
      newId: () => randomUUID(),
    });

    // Theme and language (spec §6.10, §12): the profile's own cb-theme / NEXT_LOCALE cookies, the
    // app's choice before any profile, else the OS. Every page, window and menu reads them here.
    const prefs = createPreferences({
      file: join(app.getPath("userData"), "preferences.json"),
      fs,
      cookiesFor: (p) =>
        session.fromPartition(partitionFor(p.id)).cookies as unknown as CookieJarLike,
      osLocale: () => app.getLocale(),
      onChange: () => preferencesChanged(),
      log: (message, err) => console.error(message, err ?? ""),
    });
    /** The stored profile (its last chrome@1 report) for one a caller may hold an old copy of. */
    const freshProfile = (p?: Pick<Profile, "id">): Profile | undefined =>
      p ? profiles.get(p.id) : undefined;
    const appearanceOf = (p?: Pick<Profile, "id">) => {
      const profile = freshProfile(p);
      return resolveAppearance(
        nativeTheme.shouldUseDarkColors,
        profile?.appearance,
        prefs.theme(profile),
      );
    };
    const localeOf = (p?: Pick<Profile, "id">) => prefs.locale(freshProfile(p));
    /** The menus' language: the current profile's once one exists, else the app's, else the OS. */
    const menuLocale = () => prefs.menuLocale(freshProfile(profiles.lastUsed()), visibleProfiles());
    /**
     * A theme or language changed (a toggle, a cookie the web wrote, a chrome@1 report, the OS):
     * every local page re-renders, the small window recolors, the menus follow the language.
     */
    function preferencesChanged(): void {
      localPages.push();
      onboarding.refresh();
      ui.stateChanged();
    }
    nativeTheme.on("updated", () => preferencesChanged());

    // One dialog at a time per profile, for a page's call and the tray's click alike.
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
      localPreloadPath: join(dist, "preload", "local.cjs"),
      platform,
      appName: brand.productName,
      openExternal: (url) => shell.openExternal(url),
      describe: (profile) => bridge.describe(profile),
      describeEvents: (profile) => bridge.describeEvents(profile),
      // Each load of a deployment window asks its discovery again whether device@1 is offered.
      onProfileLoad: (profile) => void deviceAvailability.evaluate(profile),
      onProfileClosed: (id) => bridge.dropSubscriptions(id),
      // Sign-out (spec §6.9): the partition's logout completion and the window's /login.
      onPartitionPrepared: (profile, partition) =>
        watchLogout(
          session.fromPartition(partition) as unknown as CompletedSession,
          profile.base,
          () => signOut.noteLoggedOut(profile.id),
        ),
      onProfileWindow: (profile, win) =>
        watchLoginNavigations(win.webContents, profile, signOutOnLogin(signOut, profile.id)),
      onFocusProfile: (profile) => {
        profiles.setLastUsed(profile.id);
        ui.stateChanged();
      },
      // Only to each profile's own origin; the token exchange sets the same value itself.
      userAgent: desktopUserAgent(shellVersion, hostname()),
      backgroundColor: (profile) => backgroundOf(appearanceOf(profile)),
      // Spec §6.7: the main window opens where it was, else 1280×800 centered.
      displays: () => {
        const primary = screen.getPrimaryDisplay().id;
        return screen
          .getAllDisplays()
          .map((d) => ({ workArea: d.workArea, primary: d.id === primary }));
      },
      saveBounds: (id, bounds) => {
        profiles.update(id, { bounds });
      },
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
    bridge.registerCapability(
      CHROME_CAPABILITY_KEY,
      createChromeCapability({
        // The last report per profile carries its colors to the local pages (spec §6.10).
        onReport: (profile, appearance) => {
          profiles.update(profile.id, { appearance });
          preferencesChanged();
        },
      }),
    );
    /** The profile partition's own fetch (its cookie jar, its webRequest listeners). */
    const partitionFetch = (profile: Profile): FetchLike => {
      const ses = session.fromPartition(partitionFor(profile.id));
      return ses.fetch.bind(ses) as unknown as FetchLike;
    };
    /** Removes the session cookies from the profile partition's jar. */
    const clearSessionCookies = async (profile: Profile): Promise<void> => {
      const jar = session.fromPartition(partitionFor(profile.id)).cookies;
      await jar.remove(`${profile.base}/`, "cap_at");
      await jar.remove(`${profile.base}/`, "cap_rt");
    };
    // signIn@1 needs a user activation but confirms nothing natively (spec §8).
    const signIn = createSignIn({
      openExternal: (url) => shell.openExternal(url),
      // The partition's own fetch: the kernel's Set-Cookie lands in the profile's cookie jar.
      fetchFor: partitionFetch,
      getProfile: (id) => profiles.get(id),
      onSignedIn: (profile) => windows.reloadProfile(profile),
      // A session the app did not want: its cookies go from the partition's jar as well.
      clearSessionCookies,
      machineName: hostname(),
      appVersion: shellVersion,
      log: (message, err) => console.error(message, err ?? ""),
    });
    bridge.registerCapability(SHELL_CAPABILITY_KEYS.signIn, signIn.capability, {
      activation: ["start"],
    });
    // The local pages (small window, error overlay, shell dialogs) register here with their kind;
    // the features that own their actions install the handlers.
    const localPages = createLocalPages({
      log: (message, err) => console.error(message, err ?? ""),
    });
    localPages.install(ipcMain as unknown as IpcMainLike);
    // The cached platform icons (by the hash in the icon URL); the dialogs show them as data: URLs.
    const iconCache = createDockIconCache(
      join(app.getPath("userData"), "dock-icons"),
      fs as DockCacheFs,
    );
    const iconFor = (profile: Profile): string | undefined => {
      const png = profile.iconHash ? iconCache.readCache(profile.iconHash) : null;
      return isPng(png)
        ? `data:image/png;base64,${Buffer.from(png).toString("base64")}`
        : undefined;
    };
    // The shell dialogs (spec §7.4): no OS message box anywhere. A sheet of `parent` while that
    // window lives, else a standalone window on the active display, above the others.
    const shellDialogs = createShellDialogs({
      createWindow: (options) =>
        new BrowserWindow(
          options as unknown as ConstructorParameters<typeof BrowserWindow>[0],
        ) as unknown as DialogWindow,
      localPages,
      preloadPath: join(dist, "preload", "local.cjs"),
      liveParent: (parent) =>
        parent instanceof BrowserWindow && !parent.isDestroyed() ? parent : undefined,
      pageBase: (profileId) => ({
        locale: localeOf(profileId === undefined ? undefined : { id: profileId }),
        appearance: appearanceOf(profileId === undefined ? undefined : { id: profileId }),
        controls: null,
        os: platform,
        appName: brand.productName,
        version: shellVersion,
      }),
      workArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
      backgroundColor: (profileId) => {
        const a = appearanceOf(profileId === undefined ? undefined : { id: profileId });
        return electronColor(a.tokens?.panel) ?? BUILTIN_TOKENS[a.scheme].panel;
      },
      log: (message, err) => console.error(message, err ?? ""),
    });
    const showDialog = shellDialogs.show;
    // device@1 (spec §8, §9): native confirmations attached to the calling window.
    const device = createDeviceCapability({
      cli: deviceCli,
      service: deviceService,
      control,
      dialogs: createDeviceDialogs({
        showDialog,
        iconFor,
        get locale() {
          return menuLocale();
        },
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
    // The small window (spec §6.1): connect, found, waiting and signed-out, and the sign-in from
    // there. A profile is saved only when its first sign-in completes (spec §6.3).
    // The provisional profile whose sign-in began last: its partition gets the app's choices.
    let begun: Profile | undefined;
    const onboarding = createOnboarding({
      localPages,
      openWindow: (colors) => windows.openSmallWindow(colors).window as unknown as OnboardingWindow,
      pageBase: (profile) => ({
        locale: localeOf(profile),
        appearance: appearanceOf(profile),
        os: platform,
        appName: brand.productName,
        version: shellVersion,
      }),
      controls: smallWindowControls(platform),
      colors: (appearance) => ({
        background: backgroundOf(appearance),
        symbol: overlayColors(appearance).symbolColor,
      }),
      discover: (base, signal) => discover(base, net.fetch as typeof fetch, signal),
      platformIcon: async (deployment, icon) => {
        const found = await fetchPlatformIcon(deployment, icon, {
          fetch: net.fetch as typeof fetch,
          ...iconCache,
          log: (message, err) => console.error(message, err ?? ""),
        });
        if (!found) return {};
        return { iconUrl: pngDataUrl(found.png), ...(found.hash ? { iconHash: found.hash } : {}) };
      },
      storedIcon: iconFor,
      isAllowed: (address) => isAddressAllowed(managed, address),
      findProfile: (base) => profiles.list().find((p) => p.base === base),
      newId: () => randomUUID(),
      signIn: {
        ...signIn,
        // Spec §6.10: the app's choices seed the partition before the sign-in can load anything
        // in it (a cookie it holds already stays).
        begin: (profile) => {
          begun = profile;
          void prefs.seed(profile);
          return signIn.begin(profile);
        },
      },
      redirectUri: REDIRECT_URI,
      openExternal: (url) => shell.openExternal(url),
      writeClipboard: (text) => clipboard.writeText(text),
      saveProfile: (provisional, account) => {
        // Saved meanwhile under another id (a managed profile): returned as is, not signed in.
        const other = profiles.list().find((p) => p.base === provisional.base);
        if (other && other.id !== provisional.id) return other;
        const added = profiles.add({
          id: provisional.id,
          base: provisional.base,
          origin: provisional.origin,
          name: provisional.name,
          ...(provisional.iconHash ? { iconHash: provisional.iconHash } : {}),
        });
        const saved = profiles.update(added.id, { signedIn: true, account }) ?? added;
        void prefs.seed(saved).finally(() => prefs.watch(saved));
        ui.profilesChanged();
        trayDevice.refresh();
        return saved;
      },
      markSignedIn: (id, account) => {
        const saved = profiles.update(id, { signedIn: true, account });
        ui.stateChanged();
        return saved;
      },
      openMain: (profile, home) => {
        profiles.setLastUsed(profile.id);
        windows.showProfile(profile, home ? `${profile.base}/` : undefined);
        ui.stateChanged();
      },
      clearPartition: async (id) => {
        const ses = session.fromPartition(partitionFor(id));
        await ses.clearStorageData();
        await ses.clearCache();
      },
      removeProfile: (id) => void removal.remove(id),
      canRemove: () => managed.lockDeployments !== true,
      deviceConnected: (id) => {
        const d = trayDevice.current();
        return d.icon !== "not_connected" && d.profileId === id;
      },
      machineName: machineNameFrom(hostname()),
      log: (message, err) => console.error(message, err ?? ""),
    });

    // Under `lockDeployments` the app offers only the managed profiles (an older saved one stays
    // on disk but is not offered).
    const isVisible = (p: Profile): boolean =>
      managed.lockDeployments !== true || isAddressAllowed(managed, p.base);
    const visibleProfiles = (): Profile[] => profiles.list().filter(isVisible);

    /**
     * A profile's window (spec §6.3): signed in, its main window; signed out, the small window's
     * signed-out page; never signed in (a managed profile), its found page.
     */
    const openProfile = (profile: Profile, url?: string) => {
      profiles.setLastUsed(profile.id);
      if (profile.signedIn) windows.showProfile(profile, url);
      else if (profile.account) onboarding.showSignedOut(profile);
      else onboarding.showFound(profile);
    };

    const openDefault = () => {
      const visible = visibleProfiles();
      const last = profiles.lastUsed();
      const target = last && visible.some((p) => p.id === last.id) ? last : visible[0];
      if (target) openProfile(target);
      // First launch (of a managed install: with the first managed address ready).
      else onboarding.openConnect(managed.profiles?.[0]);
    };

    // This machine's device in the tray (spec §9.6). Its actions are device@1's own functions.
    const trayDevice = createTrayDevice({
      // Managed 「连接本机」 off: no device in the tray, like device@1 is not offered.
      enabled: managed.connectThisMachine !== false,
      control,
      readMachine: () => readMachine(deviceCli),
      readKeepAwake: () => readKeepAwake(deviceCli),
      profiles: visibleProfiles,
      impl: device.impl,
      gate: confirmGate,
      openDevicePage: (profile, path) => windows.showProfile(profile, profile.base + path),
      onChange: () => {
        ui.stateChanged();
        // The signed-out page's device note follows the device.
        onboarding.refresh();
      },
      log: (message, err) => console.error(message, err ?? ""),
    });
    // Quitting ends the UI only: the tray's subscription ends, the service keeps running.
    app.on("will-quit", () => trayDevice.dispose());

    // Tray, app menu and Dock icon: one refresh after anything that changes the profiles.
    const startAtLogin = createStartAtLogin(app);
    // Spec §6.3: from the app menu or the tray; never under `lockDeployments` (the offered
    // profiles are then the managed ones).
    const removal = createProfileRemoval({
      getProfile: (id) => visibleProfiles().find((p) => p.id === id),
      isRemovable: () => managed.lockDeployments !== true,
      gate: confirmGate,
      dialogParent: (id) => windows.dialogParent(id),
      showDialog,
      iconFor,
      get locale() {
        return menuLocale();
      },
      beforeRemoveDevice: (profile, parent) => device.beforeRemoveProfile(profile, parent),
      closeProfileWindows: (id) => {
        windows.closeProfileWindows(id);
        onboarding.profileRemoved(id);
      },
      removeProfile: async (id) => {
        await profiles.remove(id);
        prefs.forget(id);
      },
      forgetAvailability: (id) => deviceAvailability.forget(id),
      onRemoved: () => {
        ui.profilesChanged();
        trayDevice.refresh();
      },
      log: (message, err) => console.error(message, err ?? ""),
    });
    // Sign-out (spec §6.9): the web's own 「退出登录」 (seen through the partition's logout and the
    // next /login) and the 「平台」 menu's entry (a shell dialog, then the logout POST).
    const signOut = createSignOut({
      getProfile: (id) => profiles.get(id),
      markSignedOut: (id) => profiles.update(id, { signedIn: false }),
      showSignedOut: (profile) => onboarding.showSignedOut(profile),
      closeProfileWindows: (id) => windows.closeProfileWindows(id),
      confirm: (profile) =>
        shellDialogs.confirmSignOut(
          windows.dialogParent(profile.id) ?? null,
          dialogPlatformOf(profile, iconFor(profile)),
          profile.id,
        ),
      fetchFor: partitionFetch,
      clearSessionCookies,
      onSignedOut: () => ui.stateChanged(),
      gate: confirmGate,
      log: (message, err) => console.error(message, err ?? ""),
    });
    const uiActions = {
      showProfile: (id: string) => {
        const profile = visibleProfiles().find((p) => p.id === id);
        if (!profile) return;
        openProfile(profile);
        ui.stateChanged();
      },
      addPlatform: () => {
        onboarding.openConnect();
      },
      removeProfile: (id: string) => void removal.remove(id),
      signOut: (id: string) => void signOut.confirmAndSignOut(id),
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
      ...iconCache,
      log: (message, err) => console.error(message, err ?? ""),
    });
    function render(): void {
      const visible = visibleProfiles();
      const state = {
        locale: menuLocale(),
        profiles: visible.map((p) => ({ id: p.id, name: p.name, signedIn: p.signedIn })),
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

    // `connect` only prefills the connect page; `open` only focuses an existing profile.
    const deepLinkHandlers = createDeepLinkHandlers({
      profiles: visibleProfiles,
      isAllowedAddress: (address) => isAddressAllowed(managed, address),
      openConnect: (prefill) => onboarding.openConnect(prefill),
      showProfile: (profile, url) => openProfile(profile, url),
    });

    const router = createDeepLinkRouter({
      scheme: brand.scheme,
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

    // The local pages' theme and language toggles (spec §6.10): the page's profile, else the app
    // level. A provisional profile's pages are app level; its partition follows the app's choice.
    const reseedProvisional = async () => {
      const current = onboarding.current();
      if (current?.provisional && begun && current.profileId === begun.id) {
        await prefs.seed(begun, { overwrite: true });
      }
    };
    installPreferenceActions({
      localPages,
      prefs,
      getProfile: (id) => profiles.get(id),
      appearanceOf,
      afterAppLevel: reseedProvisional,
    });
    for (const p of profiles.list()) void prefs.watch(p);

    ui.profilesChanged();
    trayDevice.start();
    openDefault();

    // Managed profiles (spec §6.4) are ensured lazily and never block the start: each one that is
    // not saved yet is discovered like an address typed on the connect page and saved (not signed
    // in) when it answers; one that does not answer is tried again at the next launch.
    void ensureManagedProfiles(managed.profiles ?? [], {
      has: (base) => profiles.list().some((p) => p.base === base),
      discover: async (base) => {
        const found = await discover(base, net.fetch as typeof fetch);
        if (!found.ok) return { ok: false };
        const origin = new URL(found.base).origin;
        const icon = platformIconUrl({ base: found.base, origin }, found.meta.icon);
        return {
          ok: true,
          candidate: {
            base: found.base,
            origin,
            name: platformName(found.meta, new URL(origin).host),
            ...(icon?.hash ? { iconHash: icon.hash } : {}),
          },
        };
      },
      add: (candidate) => {
        const added = profiles.add(candidate);
        void prefs.seed(added).finally(() => prefs.watch(added));
        return added;
      },
    }).then((added) => {
      if (added > 0) {
        ui.profilesChanged();
        trayDevice.refresh();
      }
    });

    // electron-updater works only in a packaged app. An update installs on quit, so the
    // `afterUpdate` call at the next start is the one that finds the new device on disk and
    // restarts the service on it.
    if (app.isPackaged) {
      void deviceService
        .repairService()
        .then(() => deviceService.afterUpdate())
        .catch((err: unknown) => console.error("device service check failed", err));
      const updates = setupUpdates({
        autoUpdater,
        managed,
        logger: { info: console.info, error: console.error },
        // Once per version: a notification whose click restarts into the new version now.
        onDownloaded: (info) => notice(info),
      });
      const notice = updateNotice({
        Notification: Notification as unknown as NotificationClass,
        get locale() {
          return menuLocale();
        },
        restart: () => updates.restart(),
      });
      app.on("will-quit", () => updates.dispose());
      void updates.check();
    }
  });
}
