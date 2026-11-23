// Automatic updates (spec §11): electron-updater from GitHub Releases by default; managed
// configuration may turn them off or point at an internal feed. Checked at start (the caller) and
// every 6 hours; a downloaded update installs on quit, and the person is told once per version so
// they can restart now. The updater, the managed config, the scheduler and the logger are
// injected, so this module tests without Electron.
import { type Locale, t } from "@capybara-hq/shell";
import { brand } from "../../brand.ts";
import type { NotificationClass, NotificationLike } from "./capabilities.ts";

/** The part of the managed configuration this module reads (Task 15's readManagedConfig). */
export interface ManagedUpdateConfig {
  autoUpdate?: boolean;
  /** A generic-provider base URL (an internal feed). */
  updateFeed?: string;
}

/** The part of electron-updater's AppUpdater this module uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger?: unknown;
  setFeedURL(options: UpdateFeed): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type UpdateFeed =
  | { provider: "generic"; url: string }
  | { provider: "github"; owner: string; repo: string };

export interface UpdateLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface SetupUpdatesDeps {
  autoUpdater: UpdaterLike;
  managed: ManagedUpdateConfig;
  logger?: UpdateLogger;
  /**
   * A new version was downloaded (called once per version): tell the person it installs on quit
   * or with `restart()`.
   */
  onDownloaded?: (info: { version: string }) => void;
  /** Runs `fn` every `ms`; returns a cancel function. Default: an unref'd `setInterval`. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface UpdatesHandle {
  enabled: boolean;
  /** The feed in use, or null when updates are off. */
  feed: UpdateFeed | null;
  /** Checks for an update now; resolves when the check ended (never rejects). */
  check(): Promise<void>;
  /** Quits and installs the downloaded update now. */
  restart(): void;
  /** Stops the periodic check. */
  dispose(): void;
}

/** How often a running app checks for an update. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface IntervalTimers<T> {
  setInterval(fn: () => void, ms: number): T;
  clearInterval(timer: T): void;
}

/** A scheduler over `setInterval` whose timer never keeps the process alive. */
export function intervalScheduler<T extends { unref?: () => unknown }>(
  timers: IntervalTimers<T>,
): (fn: () => void, ms: number) => () => void {
  return (fn, ms) => {
    const timer = timers.setInterval(fn, ms);
    timer.unref?.();
    return () => timers.clearInterval(timer);
  };
}

const OFF = { check: async () => {}, restart: () => {}, dispose: () => {} };

/** A feed URL must be https (or http on loopback for a test feed). */
export function genericFeed(raw: string): UpdateFeed | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return { provider: "generic", url: url.toString() };
}

export function setupUpdates(deps: SetupUpdatesDeps): UpdatesHandle {
  const { autoUpdater, managed, logger } = deps;
  if (managed.autoUpdate === false) {
    logger?.info("automatic updates are off (managed configuration)");
    return { enabled: false, feed: null, ...OFF };
  }

  let feed: UpdateFeed;
  if (managed.updateFeed !== undefined) {
    const custom = genericFeed(managed.updateFeed);
    if (custom === null) {
      logger?.error("the managed updateFeed is not a valid https URL; updates are off");
      return { enabled: false, feed: null, ...OFF };
    }
    feed = custom;
  } else {
    feed = { provider: "github", owner: brand.updateFeed.owner, repo: brand.updateFeed.repo };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL(feed);
  autoUpdater.on("error", (error) => logger?.error(`update error: ${error.message}`));
  const announced = new Set<string>();
  autoUpdater.on("update-downloaded", (info) => {
    logger?.info(`update ${info.version} downloaded`);
    if (announced.has(info.version)) return;
    announced.add(info.version);
    try {
      deps.onDownloaded?.(info);
    } catch (error) {
      logger?.error(
        `could not announce the update: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const check = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logger?.error(
        `update check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const schedule =
    deps.schedule ??
    intervalScheduler<ReturnType<typeof setInterval>>({ setInterval, clearInterval });
  const cancel = schedule(() => void check(), CHECK_INTERVAL_MS);

  return {
    enabled: true,
    feed,
    check,
    restart: () => autoUpdater.quitAndInstall(),
    dispose: cancel,
  };
}

/**
 * The `onDownloaded` of the app: a native notification (zh, en) whose click restarts into the
 * downloaded version. Without notification support the update still installs on quit.
 */
export function updateNotice(deps: {
  Notification: NotificationClass;
  locale: Locale;
  restart(): void;
}): (info: { version: string }) => void {
  // Keep a reference until clicked or closed: macOS loses the click of a collected notification.
  const live = new Set<NotificationLike>();
  return (info) => {
    if (!deps.Notification.isSupported()) return;
    const n = new deps.Notification({
      title: t(deps.locale, "update.ready.title", { name: brand.productName }),
      body: t(deps.locale, "update.ready.body", { version: info.version }),
    });
    live.add(n);
    n.on("click", () => {
      live.delete(n);
      deps.restart();
    });
    n.on("close", () => live.delete(n));
    n.show();
  };
}
