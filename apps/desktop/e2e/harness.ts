// Shared by the e2e specs: launches the real Electron app against a temp userData directory, with
// the system browser stubbed (the URLs are captured) and no real Keychain, login item or launchd.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
} from "@playwright/test";

const appDir = fileURLToPath(new URL("..", import.meta.url));

export interface Harness {
  app: ElectronApplication;
  userData: string;
  /** The URLs the app asked the system browser to open. */
  openedUrls(): Promise<string[]>;
  /** The window on `url`, polled (a re-shown small window raises no `window` event). */
  windowOn(url: string): Promise<Page>;
  /** The URLs of the open windows' main frames. */
  windowUrls(): Promise<string[]>;
  /** The URLs of the overlays (WebContentsViews) over the open windows. */
  overlayUrls(): Promise<string[]>;
  /** The saved profiles (`profiles.json`), empty when none was saved yet. */
  profiles(): { id: string; base: string; signedIn: boolean }[];
  /** Raises `open-url` on app, the event the OS raises for a `capybara://` link. */
  deepLink(url: string): Promise<void>;
  /** The cookies of a profile's partition. */
  cookies(profileId: string, base: string, name?: string): Promise<Electron.Cookie[]>;
  /** Quits the app; `keepUserData` keeps the directory for a later `launchApp({ userData })`. */
  close(failed: boolean, tracePath: string, o?: { keepUserData?: boolean }): Promise<void>;
}

/** Launches the app on a fresh temp directory, or on `userData` of an earlier launch (a restart). */
export async function launchApp(o: { userData?: string } = {}): Promise<Harness> {
  const fresh = o.userData === undefined;
  const userData = o.userData ?? mkdtempSync(join(tmpdir(), "capybara-e2e-"));
  // The app under test never sees the developer's real config: `$XDG_CONFIG_HOME` is in the temp
  // dir.
  const configHome = join(userData, "config");
  mkdirSync(configHome, { recursive: true });
  // Electron started as Node would not open windows: ELECTRON_RUN_AS_NODE stays out.
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      CAPYBARA_E2E_USER_DATA: join(userData, "app"),
      XDG_CONFIG_HOME: configHome,
    }).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  let app: ElectronApplication | undefined;
  try {
    // `--use-mock-keychain`: Chromium keeps the cookie encryption key of a persistent partition in
    // the login Keychain ("Electron Safe Storage"); the run never reads or writes the real one,
    // and never waits on a Keychain prompt.
    app = await electron.launch({ args: [appDir, "--use-mock-keychain"], cwd: appDir, env });
    // `use.trace` records nothing for `_electron.launch`: trace the app's context here and keep
    // the trace only when a test failed.
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    // The system browser must not open: capture what the app would have opened.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __opened?: string[] }).__opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
  } catch (err) {
    await app?.close().catch(() => undefined);
    if (fresh) rmSync(userData, { recursive: true, force: true });
    throw err;
  }
  const launched = app;

  const windowUrls = () =>
    launched.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
    );
  return {
    app: launched,
    userData,
    openedUrls: () =>
      launched.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []),
    async windowOn(url) {
      let found: Page | undefined;
      await expect
        .poll(() => {
          found = launched.windows().find((w) => !w.isClosed() && w.url() === url);
          return found !== undefined;
        })
        .toBe(true);
      return found as Page;
    },
    windowUrls,
    overlayUrls: () =>
      launched.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().flatMap((w) =>
          w.contentView.children.map((v) => (v as Electron.WebContentsView).webContents.getURL()),
        ),
      ),
    profiles() {
      try {
        return (
          JSON.parse(readFileSync(join(userData, "app", "profiles.json"), "utf8")) as {
            profiles: { id: string; base: string; signedIn: boolean }[];
          }
        ).profiles;
      } catch {
        return [];
      }
    },
    deepLink: (url) =>
      launched.evaluate(({ app: electronApp }, u) => {
        electronApp.emit("open-url", { preventDefault() {} }, u);
      }, url),
    cookies: (profileId, base, name) =>
      launched.evaluate(
        ({ session }, args) =>
          session
            .fromPartition(`persist:profile-${args.profileId}`)
            .cookies.get({ url: args.base, ...(args.name ? { name: args.name } : {}) }),
        { profileId, base, name },
      ),
    async close(failed, tracePath, closeOptions) {
      try {
        await launched.context().tracing.stop(failed ? { path: tracePath } : {});
      } finally {
        try {
          await launched.close();
        } finally {
          if (!closeOptions?.keepUserData) rmSync(userData, { recursive: true, force: true });
        }
      }
    },
  };
}
