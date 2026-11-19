// The Dock icon follows a customised platform icon (spec §11): with exactly one profile whose
// deployment has set an icon, the Dock shows it; otherwise it stays Capybara. The icon is fetched
// from the profile's own origin (no redirect), accepted only as a PNG of at most 1 MB, and cached
// by the hash in its URL (`?v=`). Electron objects and the network come in as parameters.
import { fetchMeta } from "@capybara-hq/shell";
import { readCapped } from "./address.ts";
import type { Profile } from "./profiles.ts";

export const DOCK_ICON_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HASH = /^[A-Za-z0-9_-]{1,128}$/;

export function isPng(bytes: Uint8Array | null | undefined): bytes is Uint8Array {
  return (
    !!bytes &&
    bytes.byteLength > PNG_SIGNATURE.length &&
    bytes.byteLength <= DOCK_ICON_MAX_BYTES &&
    PNG_SIGNATURE.every((b, i) => bytes[i] === b)
  );
}

export interface DockIconDeps {
  fetch: typeof fetch;
  /** `app.dock.setIcon(nativeImage.createFromBuffer(png))`. */
  setIcon(png: Uint8Array): void;
  /** Puts the Capybara icon back (only called after a custom icon was set). */
  restoreDefault(): void;
  readCache(hash: string): Uint8Array | null;
  writeCache(hash: string, png: Uint8Array): void;
  log?: (message: string, err?: unknown) => void;
}

async function fetchPng(url: URL, fetchFn: typeof fetch): Promise<Uint8Array | null> {
  try {
    const res = await fetchFn(url.href, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await readCapped(res, DOCK_ICON_MAX_BYTES);
    return isPng(body) ? new Uint8Array(body) : null;
  } catch {
    return null;
  }
}

export function createDockIcon(deps: DockIconDeps) {
  let custom = false;
  let seq = 0;

  return {
    /** Re-evaluates the rule for the current profiles; a later call supersedes an earlier one. */
    async update(profiles: readonly Profile[]): Promise<void> {
      const mine = ++seq;
      const apply = (png: Uint8Array | null) => {
        if (mine !== seq) return;
        try {
          if (png) {
            deps.setIcon(png);
            custom = true;
          } else if (custom) {
            deps.restoreDefault();
            custom = false;
          }
        } catch (err) {
          deps.log?.("could not set the Dock icon", err);
        }
      };

      // One app icon cannot stand for several platforms (and switching would flicker).
      const [profile] = profiles;
      if (profiles.length !== 1 || !profile) return apply(null);

      const meta = await fetchMeta(profile.base, deps.fetch);
      if ("error" in meta) {
        // Offline or the deployment is unavailable: keep the icon this profile last had.
        const last = profile.iconHash ? deps.readCache(profile.iconHash) : null;
        return apply(isPng(last) ? last : null);
      }
      if (!meta.icon) return apply(null);

      let url: URL;
      try {
        url = new URL(meta.icon, `${profile.base}/`);
      } catch {
        return apply(null);
      }
      // The icon comes from the profile's own origin only.
      if (url.origin !== profile.origin) return apply(null);

      const v = url.searchParams.get("v");
      const hash = v !== null && HASH.test(v) ? v : null;
      if (hash) {
        const cached = deps.readCache(hash);
        if (isPng(cached)) return apply(cached);
      }
      const png = await fetchPng(url, deps.fetch);
      if (png && hash) {
        try {
          deps.writeCache(hash, png);
        } catch (err) {
          deps.log?.("could not cache the Dock icon", err);
        }
      }
      return apply(png);
    },
  };
}

export interface DockCacheFs {
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array): void;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
}

/** The icon cache: `<dir>/<hash>.png`. The hash is checked, so it cannot name another path. */
export function createDockIconCache(dir: string, fs: DockCacheFs) {
  const pathFor = (hash: string) => {
    if (!HASH.test(hash)) throw new Error("invalid icon hash");
    return `${dir}/${hash}.png`;
  };
  return {
    readCache(hash: string): Uint8Array | null {
      try {
        return fs.readFileSync(pathFor(hash));
      } catch {
        return null;
      }
    },
    writeCache(hash: string, png: Uint8Array): void {
      const file = pathFor(hash);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, file);
    },
  };
}
