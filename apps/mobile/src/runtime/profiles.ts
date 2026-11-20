// Profiles: one per deployment, each in its own WebView data store (spec §4.3, §15.2).
//
// iOS gives every profile a `WKWebsiteDataStore(forIdentifier:)`; Android an androidx.webkit
// profile where `MULTI_PROFILE` is supported ("multi"). Without it ("single", Decision 9) all
// deployments share the one store: one is signed in at a time, switching asks first and clears the
// store. The native side (DataStores.swift / DataStores.kt, the `DataStores` Capacitor plugin) never
// hands a deployment the default iOS store or Android's `Default` profile in multi mode.
import { isRecord, type Locale, normalizeAddress, t } from "@capybara-hq/shell";

export interface Profile {
  id: string;
  /** The deployment address: origin plus path prefix, no trailing slash (`normalizeAddress`). */
  base: string;
  /** The exact origin the Shell environment is offered to. */
  origin: string;
  /** The deployment's name from discovery, or null until it answers. */
  name: string | null;
  iconUrl: string | null;
  /** The native data store's identifier: a UUID (iOS requires one; Android names the profile). */
  dataStoreId: string;
  addedAt: number;
}

/**
 * The native data stores. `remove` resolves once the deletion is durably scheduled, not when the
 * data is gone: iOS deletes a store only after its WebView is released (retrying), Android only in
 * a process that never used the profile, so a deletion recorded now runs at the next cold start
 * before any profile is created. A removed store is never handed out again in the meantime.
 */
export interface DataStorePort {
  mode(): Promise<"multi" | "single">;
  /** Creates the store now (Android writes its profile registry late; see DataStores.kt). */
  create(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * Clears the store(s) deployments use: in single mode the one shared store (cookies,
   * localStorage, IndexedDB, caches, service workers). [origins] are the deployments' origins:
   * Android's default profile keeps service workers and Cache API data across a plain clear, so
   * native unregisters and deletes them per origin first.
   */
  clearAll(origins: string[]): Promise<void>;
}

/**
 * Key-value preferences. Reads are synchronous over values loaded at start-up (`preloadPrefs`), so
 * `ProfileStore.list()` stays synchronous; writes resolve once stored.
 */
export interface PrefsPort {
  get(key: string): string | null;
  set(key: string, value: string): Promise<void>;
}

export interface ProfileStore {
  list(): Profile[];
  current(): Profile | null;
  /** Adds a deployment and creates its data store; the same base again returns the first one. */
  add(input: { base: string; name: string | null; iconUrl: string | null }): Promise<Profile>;
  /** In single mode asks first (Decision 9); on ok clears the shared store, then switches. */
  setCurrent(id: string): Promise<"switched" | "cancelled">;
  /**
   * Runs the `onRemoved` listeners, then schedules the store's deletion (single mode: clears the
   * shared store when the profile is current), then forgets the profile. A removed current
   * profile hands over to the next one, else the previous one, else none.
   */
  remove(id: string): Promise<void>;
  /** The push plan's seam: listeners run before the store is removed. Returns an unsubscribe. */
  onRemoved(listener: (p: Profile) => void | Promise<void>): () => void;
}

export interface ProfileStoreDeps {
  prefs: PrefsPort;
  stores: DataStorePort;
  confirm(text: { message: string; ok: string; cancel: string }): Promise<boolean>;
  /** A fresh UUID (`crypto.randomUUID`). */
  newId(): string;
  now(): number;
  /** The UI locale for the single-mode question; English when absent. */
  locale?: () => Locale;
}

export const PROFILES_PREF_KEY = "profiles";

/** The Capacitor plugin name of the native data stores (`registerPlugin(DATA_STORES_PLUGIN)`). */
export const DATA_STORES_PLUGIN = "DataStores";

interface StoredState {
  version: 1;
  profiles: Profile[];
  currentId: string | null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored profile is used only when it is well formed and its base still normalizes to itself. */
function parseProfile(v: unknown): Profile | null {
  if (!isRecord(v)) return null;
  const { id, base, origin, name, iconUrl, dataStoreId, addedAt } = v;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof base !== "string" || typeof origin !== "string") return null;
  if (name !== null && typeof name !== "string") return null;
  if (iconUrl !== null && typeof iconUrl !== "string") return null;
  if (typeof dataStoreId !== "string" || !UUID.test(dataStoreId)) return null;
  if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) return null;
  const n = normalizeAddress(base);
  if (!n.ok || n.base !== base || n.origin !== origin) return null;
  return { id, base, origin, name, iconUrl, dataStoreId, addedAt };
}

function readState(prefs: PrefsPort): StoredState {
  const empty: StoredState = { version: 1, profiles: [], currentId: null };
  let raw: unknown;
  try {
    const text = prefs.get(PROFILES_PREF_KEY);
    if (text === null) return empty;
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) return empty;
  const profiles: Profile[] = [];
  for (const entry of raw.profiles) {
    const p = parseProfile(entry);
    if (
      p &&
      !profiles.some((q) => q.id === p.id || q.base === p.base || q.dataStoreId === p.dataStoreId)
    ) {
      profiles.push(p);
    }
  }
  const stored = typeof raw.currentId === "string" ? raw.currentId : null;
  const currentId =
    stored && profiles.some((p) => p.id === stored) ? stored : (profiles[0]?.id ?? null);
  return { version: 1, profiles, currentId };
}

export function createProfileStore(deps: ProfileStoreDeps): ProfileStore {
  const { prefs, stores } = deps;
  let state = readState(prefs);
  const origins = () => [...new Set(state.profiles.map((p) => p.origin))];
  const listeners = new Set<(p: Profile) => void | Promise<void>>();
  // Mutations run one after another, so two adds of one base never both create a store.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function save(next: StoredState): Promise<void> {
    await prefs.set(PROFILES_PREF_KEY, JSON.stringify(next));
    state = next;
  }

  const copy = (p: Profile): Profile => ({ ...p });

  return {
    list: () => state.profiles.map(copy),

    current: () => {
      const p = state.profiles.find((q) => q.id === state.currentId);
      return p ? copy(p) : null;
    },

    add: (input) =>
      serial(async () => {
        const n = normalizeAddress(input.base);
        if (!n.ok) throw new Error(`not a deployment address (${n.reason})`);
        const existing = state.profiles.find((p) => p.base === n.base);
        if (existing) return copy(existing);
        const profile: Profile = {
          id: deps.newId(),
          base: n.base,
          origin: n.origin,
          name: input.name,
          iconUrl: input.iconUrl,
          dataStoreId: deps.newId().toLowerCase(),
          addedAt: deps.now(),
        };
        // The store is created as soon as the deployment is added, not at its first load: Android
        // writes its profile-name registry about 10 s after a profile is first created, and a kill
        // before that lost or swapped names in spike 1.3.
        await stores.create(profile.dataStoreId);
        try {
          await save({
            ...state,
            profiles: [...state.profiles, profile],
            currentId: state.currentId ?? profile.id,
          });
        } catch (err) {
          await stores.remove(profile.dataStoreId).catch(() => undefined);
          throw err;
        }
        return copy(profile);
      }),

    setCurrent: (id) =>
      serial(async () => {
        const target = state.profiles.find((p) => p.id === id);
        if (!target) throw new Error("unknown profile");
        if (state.currentId === id) return "switched";
        if ((await stores.mode()) === "single" && state.currentId !== null) {
          const locale = deps.locale?.() ?? "en";
          const ok = await deps.confirm({
            message: t(locale, "profile.switch_confirm.message"),
            ok: t(locale, "profile.switch_confirm.confirm"),
            cancel: t(locale, "profile.switch_confirm.cancel"),
          });
          if (!ok) return "cancelled";
          // The shared store holds the current deployment's session: clear it before another
          // deployment can load into it.
          await stores.clearAll(origins());
        }
        await save({ ...state, currentId: id });
        return "switched";
      }),

    remove: (id) =>
      serial(async () => {
        const index = state.profiles.findIndex((p) => p.id === id);
        const target = state.profiles[index];
        if (!target) return;
        for (const listener of [...listeners]) {
          try {
            await listener(copy(target));
          } catch {
            // A failing listener (the push registration) never keeps a profile the person removed.
          }
        }
        if ((await stores.mode()) === "single") {
          if (state.currentId === id) await stores.clearAll(origins());
        } else {
          await stores.remove(target.dataStoreId);
        }
        const profiles = state.profiles.filter((p) => p.id !== id);
        const currentId =
          state.currentId === id
            ? (profiles[index]?.id ?? profiles[index - 1]?.id ?? null)
            : state.currentId;
        await save({ ...state, profiles, currentId });
      }),

    onRemoved: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** An async key-value backend, such as `@capacitor/preferences`. */
export interface PrefsBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Loads `keys` once, then serves reads from memory and writes through to the backend. */
export async function preloadPrefs(backend: PrefsBackend, keys: string[]): Promise<PrefsPort> {
  const values = new Map<string, string | null>();
  for (const key of keys) values.set(key, await backend.get(key));
  return {
    get: (key) => values.get(key) ?? null,
    set: async (key, value) => {
      await backend.set(key, value);
      values.set(key, value);
    },
  };
}

/** The shape of the native `DataStores` plugin as Capacitor exposes it. */
export interface DataStoresNative {
  mode(): Promise<{ mode: "multi" | "single" }>;
  create(options: { id: string }): Promise<void>;
  remove(options: { id: string }): Promise<void>;
  clearAll(options: { origins: string[] }): Promise<void>;
}

export function dataStorePortFrom(native: DataStoresNative): DataStorePort {
  return {
    // Anything but "multi" is treated as the shared store: switching then asks and clears.
    mode: async () => ((await native.mode()).mode === "multi" ? "multi" : "single"),
    create: (id) => native.create({ id }),
    remove: (id) => native.remove({ id }),
    clearAll: (origins) => native.clearAll({ origins }),
  };
}
