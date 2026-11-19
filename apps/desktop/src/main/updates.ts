// Automatic updates (spec §11): electron-updater from GitHub Releases by default; managed
// configuration may turn them off or point at an internal feed. The updater, the managed config
// and the logger are injected, so this module tests without Electron.
import { brand } from "../../brand.ts";

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
   * Runs once an update has been downloaded, before it installs on quit. Task 17 hooks
   * `service restart` here (when the bundled device changed).
   */
  afterUpdate?: (info: { version: string }) => void | Promise<void>;
}

export interface UpdatesHandle {
  enabled: boolean;
  /** The feed in use, or null when updates are off. */
  feed: UpdateFeed | null;
  /** Checks for an update now; resolves when the check ended (never rejects). */
  check(): Promise<void>;
}

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
  const { autoUpdater, managed, logger, afterUpdate } = deps;
  if (managed.autoUpdate === false) {
    logger?.info("automatic updates are off (managed configuration)");
    return { enabled: false, feed: null, check: async () => {} };
  }

  let feed: UpdateFeed;
  if (managed.updateFeed !== undefined) {
    const custom = genericFeed(managed.updateFeed);
    if (custom === null) {
      logger?.error("the managed updateFeed is not a valid https URL; updates are off");
      return { enabled: false, feed: null, check: async () => {} };
    }
    feed = custom;
  } else {
    feed = { provider: "github", owner: brand.updateFeed.owner, repo: brand.updateFeed.repo };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL(feed);
  autoUpdater.on("error", (error) => logger?.error(`update error: ${error.message}`));
  autoUpdater.on("update-downloaded", (info) => {
    logger?.info(`update ${info.version} downloaded`);
    if (!afterUpdate) return;
    Promise.resolve(afterUpdate(info)).catch((error: unknown) =>
      logger?.error(
        `afterUpdate failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  });

  return {
    enabled: true,
    feed,
    check: async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        logger?.error(
          `update check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
