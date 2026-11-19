// Managed configuration (spec §6.4): macOS managed preferences of `brand.appId`, written by an MDM
// profile. They may list profiles, lock the app to them, turn automatic updates off or point them
// at an internal feed, and turn 「连接本机」 off. The file reader is injected, so tests use fakes.
//
// Values come from outside the app: every field is validated on its own and a malformed one is
// ignored (the others still apply); a missing or unreadable file reads as `{}`.
import { normalizeAddress } from "@capybara-hq/shell";
import type { Discovery } from "./address.ts";
import type { NewProfile } from "./profiles.ts";

export interface ManagedConfig {
  /** Deployment bases (`normalizeAddress(...).base`) the app should have, in order, no duplicates. */
  profiles?: string[];
  /** Only the listed profiles may be added or connected to. */
  lockDeployments?: boolean;
  autoUpdate?: boolean;
  /** An https base URL of an internal update feed. */
  updateFeed?: string;
  /** false hides 「连接本机」. */
  connectThisMachine?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates one preferences dictionary. Unknown keys and malformed values are dropped. */
export function parseManagedConfig(raw: unknown): ManagedConfig {
  if (!isRecord(raw)) return {};
  const out: ManagedConfig = {};
  if (Array.isArray(raw.profiles)) {
    const bases: string[] = [];
    for (const entry of raw.profiles) {
      if (typeof entry !== "string") continue;
      const address = normalizeAddress(entry);
      if (address.ok && !bases.includes(address.base)) bases.push(address.base);
    }
    out.profiles = bases;
  }
  if (typeof raw.lockDeployments === "boolean") out.lockDeployments = raw.lockDeployments;
  if (typeof raw.autoUpdate === "boolean") out.autoUpdate = raw.autoUpdate;
  if (typeof raw.updateFeed === "string") {
    try {
      const url = new URL(raw.updateFeed);
      if (url.protocol === "https:" && url.username === "" && url.password === "") {
        out.updateFeed = url.toString();
      }
    } catch {
      // Not a URL: ignored.
    }
  }
  if (typeof raw.connectThisMachine === "boolean") out.connectThisMachine = raw.connectThisMachine;
  return out;
}

export interface ManagedDeps {
  /** `brand.appId`: the preferences domain. */
  appId: string;
  /** The login name of the current user (for the per-user domain). */
  user: string;
  /** The parsed plist at `file`, or undefined when there is none or it cannot be read. */
  readPlist(file: string): unknown;
  /** Defaults to the macOS location. */
  directory?: string;
}

const MANAGED_DIRECTORY = "/Library/Managed Preferences";

/**
 * System-wide preferences first, then the per-user ones over them. A lock set by either level
 * stays set: the per-user file cannot lift what the system-wide one locked.
 */
export function readManagedConfig(deps: ManagedDeps): ManagedConfig {
  const dir = deps.directory ?? MANAGED_DIRECTORY;
  const system = parseManagedConfig(deps.readPlist(`${dir}/${deps.appId}.plist`));
  const user = /^[A-Za-z0-9._-]{1,64}$/.test(deps.user)
    ? parseManagedConfig(deps.readPlist(`${dir}/${deps.user}/${deps.appId}.plist`))
    : {};
  const merged: ManagedConfig = { ...system, ...user };
  if (system.lockDeployments === true || user.lockDeployments === true) {
    merged.lockDeployments = true;
  }
  return merged;
}

export interface PlistReaderDeps {
  existsSync(path: string): boolean;
  /** `child_process.execFileSync`, restricted to what the reader calls. */
  execFileSync(
    file: string,
    args: string[],
    options: { encoding: "utf8"; timeout: number },
  ): string;
}

/** Reads a plist as JSON through `plutil` (no npm dependency); any failure is `undefined`. */
export function createPlistReader(deps: PlistReaderDeps): (file: string) => unknown {
  return (file) => {
    try {
      if (!deps.existsSync(file)) return undefined;
      const json = deps.execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], {
        encoding: "utf8",
        timeout: 5000,
      });
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  };
}

/** Whether `input` may be added or connected to under `managed` (always, unless locked). */
export function isAddressAllowed(managed: ManagedConfig, input: string): boolean {
  if (managed.lockDeployments !== true) return true;
  const address = normalizeAddress(input);
  return address.ok && (managed.profiles ?? []).includes(address.base);
}

export interface EnsureProfilesDeps {
  /** Whether a profile for `base` is saved already. */
  has(base: string): boolean;
  /** The address page's discovery (the network call). */
  discover(base: string): Promise<Discovery>;
  add(candidate: NewProfile): unknown;
}

/**
 * Makes sure each managed profile exists (spec §6.4). Lazy by design: a profile is saved only once
 * its deployment answers discovery (name, icon and the too-old check come from there), so nothing
 * is needed at startup and an unreachable one is simply retried at the next launch. Returns how
 * many were added; never throws.
 */
export async function ensureManagedProfiles(
  bases: readonly string[],
  deps: EnsureProfilesDeps,
): Promise<number> {
  let added = 0;
  for (const base of bases) {
    if (deps.has(base)) continue;
    try {
      const found = await deps.discover(base);
      // The discovered address must be the managed one: nothing else is saved on its behalf.
      if (found.result.ok && found.candidate && found.candidate.base === base) {
        deps.add(found.candidate);
        added += 1;
      }
    } catch {
      // Tried again at the next launch.
    }
  }
  return added;
}
