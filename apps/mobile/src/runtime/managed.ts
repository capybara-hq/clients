// Managed configuration (mobile spec §4.3, Decision 8): an MDM sets `presetUrl` and
// `lockToPreset`, the brand file's keys, through iOS AppConfig (`com.apple.configuration.managed`,
// ManagedConfig.swift) or Android managed configurations (`RestrictionsManager`,
// ManagedConfig.kt). Native passes the raw values on, typed but otherwise unchecked; they are
// untrusted input, parsed here strictly: an https deployment address with no userinfo,
// normalized by the shell's `normalizeAddress`, and a real boolean.
//
// A lock hides the other profiles (they are never loaded or offered, their WebViews are torn
// down, and adding them is refused) but never deletes a data store: lifting the lock shows them
// again, still signed in, except in Android's single-store mode (Decision 9), where switching to
// the preset clears the one shared store, so they come back signed out. A lock that arrives while
// the app runs re-evaluates the current profile at once (profile-access.ts `reconcile`).
import { isRecord, normalizeAddress } from "@capybara-hq/shell";
import type { Brand } from "../../brand.ts";
import type { Profile, ProfileStore } from "./profiles.ts";

/** The managed values that survived parsing; an absent key was missing or invalid. */
export interface ManagedValues {
  /** A normalized https deployment base (`normalizeAddress(...).base`). */
  presetUrl?: string;
  lockToPreset?: boolean;
}

/** The preset in force and whether only it is usable. */
export interface Policy {
  presetUrl: string | null;
  locked: boolean;
}

/** An https base, or null: http (loopback included: that exception is for typing) never presets. */
function presetBase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const a = normalizeAddress(value);
  return a.ok && a.origin.startsWith("https:") ? a.base : null;
}

/** Strict parsing of the raw managed dictionary: each bad field is dropped on its own. */
export function parseManaged(raw: unknown): ManagedValues {
  if (!isRecord(raw) || Array.isArray(raw)) return {};
  const out: ManagedValues = {};
  const base = presetBase(raw.presetUrl);
  if (base !== null) out.presetUrl = base;
  if (typeof raw.lockToPreset === "boolean") out.lockToPreset = raw.lockToPreset;
  return out;
}

/**
 * Decision 8: a brand with `lockToPreset` wins over MDM; otherwise valid managed values override
 * the brand's, each on its own (a managed lock with only the brand's preset locks to the brand's
 * preset). A lock without any preset locks nothing. Presets are re-checked here, so values that
 * skipped `parseManaged` cannot slip through.
 */
export function effectivePreset(
  brand: Pick<Brand, "presetUrl" | "lockToPreset">,
  managed: ManagedValues | null,
): Policy {
  const fromBrand = presetBase(brand.presetUrl);
  if (brand.lockToPreset && fromBrand !== null) return { presetUrl: fromBrand, locked: true };
  const presetUrl = presetBase(managed?.presetUrl) ?? fromBrand;
  if (presetUrl === null) return { presetUrl: null, locked: false };
  return { presetUrl, locked: managed?.lockToPreset === true };
}

/** What the policy lets the person see and add. Hiding only: nothing is removed. */
export function applyPolicy<P extends { base: string }>(
  policy: Policy,
  profiles: P[],
): { visible: P[]; canAdd(base: string): boolean } {
  if (!policy.locked || policy.presetUrl === null) {
    return { visible: profiles, canAdd: () => true };
  }
  const preset = policy.presetUrl;
  return {
    visible: profiles.filter((p) => p.base === preset),
    canAdd: (base) => {
      const a = normalizeAddress(base);
      return a.ok && a.base === preset;
    },
  };
}

/**
 * Under a lock: the preset's profile exists (added when missing, discovery fills its name later)
 * and is current, switched to without the single-mode question (the store is still cleared).
 * Returns it and whether the current profile moved, or null when nothing is locked.
 */
export async function enforcePolicy(
  policy: Policy,
  profiles: ProfileStore,
): Promise<{ profile: Profile; moved: boolean } | null> {
  if (!policy.locked || policy.presetUrl === null) return null;
  const preset = policy.presetUrl;
  const before = profiles.current()?.id ?? null;
  const own =
    profiles.list().find((p) => p.base === preset) ??
    (await profiles.add({ base: preset, name: null, iconUrl: null }));
  // The first profile added becomes current on its own; that is a move too.
  if (profiles.current()?.id !== own.id) await profiles.setCurrent(own.id, { forced: true });
  return { profile: own, moved: before !== own.id };
}

/** Where the raw managed values come from (the native `ManagedConfig` plugin). */
export interface ManagedSource {
  read(): Promise<unknown>;
  /** Each change carries the whole new dictionary (or garbage, which parses as empty). */
  onChange(listener: (raw: unknown) => void): () => void;
}

/** The Capacitor plugin name (ManagedConfig.swift / ManagedConfig.kt). */
export const MANAGED_CONFIG_PLUGIN = "ManagedConfig";

/** The plugin's JavaScript surface. */
export interface ManagedConfigNative {
  get(): Promise<{ config: unknown }>;
  addListener(
    eventName: "change",
    listener: (e: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

export function managedSourceFrom(native: ManagedConfigNative): ManagedSource {
  const configOf = (e: unknown) => (isRecord(e) ? e.config : undefined);
  // A read waits until every listener is registered natively: Capacitor drops a `change` sent
  // before that, so reading afterwards is what closes the gap.
  let listening: Promise<unknown> = Promise.resolve();
  return {
    read: async () => {
      await listening;
      return configOf(await native.get());
    },
    onChange(listener) {
      let removed = false;
      const handle = native.addListener("change", (e) => {
        if (!removed) listener(configOf(e));
      });
      // A missing plugin rejects here; that is no managed config, never an unhandled rejection.
      handle.catch(() => {});
      listening = Promise.all([listening, handle.catch(() => undefined)]);
      return () => {
        removed = true;
        handle.then((h) => h.remove()).catch(() => {});
      };
    },
  };
}

export interface ManagedPolicy {
  /** The managed values in force (for `startRoute`). */
  values(): ManagedValues;
  policy(): Policy;
  /** The profiles the switcher, the error page, the loader and the registry may use. */
  visible(): Profile[];
  canAdd(base: string): boolean;
  /** Resolves once every change received so far is applied (tests, and ordering in the runtime). */
  settled(): Promise<void>;
  stop(): void;
}

export interface ManagedPolicyDeps {
  brand: Pick<Brand, "presetUrl" | "lockToPreset">;
  source: ManagedSource;
  profiles: ProfileStore;
  /**
   * Runs after every change, whether its enforcement succeeded or not: takes a profile that is
   * no longer visible off screen and shows what should be (profile-access.ts `reconcile`).
   */
  changed(): Promise<void> | void;
  /** A diagnostic line for an MDM admin (a lock that locks nothing, a failed read). */
  log?(message: string): void;
}

/**
 * Subscribes, then reads the managed values (a failed read is no managed config: there is
 * nothing to enforce), then follows changes. A change that arrives while the read is pending
 * wins over it. The start-up lock is enforced by `startRoute`; a change is enforced here, one
 * after another, then `changed` runs.
 */
export async function createManagedPolicy(deps: ManagedPolicyDeps): Promise<ManagedPolicy> {
  let values: ManagedValues = {};
  let changes = 0;
  let chain: Promise<void> = Promise.resolve();
  const policy = () => effectivePreset(deps.brand, values);
  const log = deps.log ?? (() => {});

  const take = (raw: unknown) => {
    values = parseManaged(raw);
    if (isRecord(raw) && raw.lockToPreset === true && !policy().locked) {
      log("managed lockToPreset is set but there is no valid https presetUrl: nothing is locked");
    }
  };

  const stop = deps.source.onChange((raw) => {
    changes++;
    take(raw);
    const next = policy();
    chain = chain.then(async () => {
      try {
        await enforcePolicy(next, deps.profiles);
      } catch {
        // The profile store refused (prefs or native down): the policy still hides the others,
        // `changed` takes a hidden profile off screen, and the next change or launch tries again.
      }
      try {
        await deps.changed();
      } catch {}
    });
  });

  const before = changes;
  let raw: unknown;
  try {
    raw = await deps.source.read();
  } catch {
    log("managed configuration could not be read: none applied");
    raw = undefined;
  }
  if (changes === before) take(raw);

  return {
    values: () => ({ ...values }),
    policy,
    visible: () => applyPolicy(policy(), deps.profiles.list()).visible,
    canAdd: (base) => applyPolicy(policy(), deps.profiles.list()).canAdd(base),
    settled: () => chain,
    stop,
  };
}
