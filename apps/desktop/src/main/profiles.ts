// Profiles: one per deployment, each with its own session partition (spec §6.3). Stored as JSON in
// userData with atomic writes; a corrupt file reads as empty and never stops the app.
import { dirname } from "node:path";
import { isRecord, normalizeAddress } from "@capybara-hq/shell";
import { type Appearance, validAppearance } from "../shared/appearance.ts";

export interface Profile {
  id: string;
  /** The deployment address: origin plus path prefix, no trailing slash. */
  base: string;
  /** The exact origin the Shell environment is offered to. */
  origin: string;
  /** The deployment's name from discovery, or its host. */
  name: string;
  /** The `v` of the meta icon URL, for the Dock icon cache (Task 15). */
  iconHash?: string;
  /** False until a sign-in completed; a profile read from an older file counts as signed in. */
  signedIn: boolean;
  account?: { name: string; login: string };
  /** The main window's last rectangle. */
  bounds?: ProfileBounds;
  appearance?: Appearance;
}

export interface ProfileBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `id`: the id of the provisional profile whose partition already holds the first sign-in's cookies
 * (spec §6.3); absent = a new id.
 */
export type NewProfile = Omit<Profile, "id" | "signedIn"> & { id?: string; signedIn?: boolean };
/**
 * `undefined` deletes an optional field (iconHash, account, bounds, appearance); for `name` and
 * `signedIn` it means no change.
 */
export interface ProfilePatch {
  name?: string;
  signedIn?: boolean;
  iconHash?: string | undefined;
  account?: { name: string; login: string } | undefined;
  bounds?: ProfileBounds | undefined;
  appearance?: Appearance | undefined;
}

export interface ProfileFs {
  readFileSync(path: string, encoding: "utf8"): string;
  openSync(path: string, flags: "w"): number;
  writeSync(fd: number, data: string): unknown;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
}

export interface PartitionSession {
  clearStorageData(): Promise<void>;
  clearCache?(): Promise<void>;
}

export interface ProfileStoreDeps {
  /** `<userData>/profiles.json`. */
  file: string;
  fs: ProfileFs;
  /** `session.fromPartition`. */
  sessionFor(partition: string): PartitionSession;
  newId(): string;
}

export interface ProfileStore {
  list(): Profile[];
  get(id: string): Profile | undefined;
  /**
   * Adds a profile; the same `base` again returns the existing one (throws while that one is
   * being removed).
   */
  add(input: NewProfile): Profile;
  /** Merges `patch` (undefined removes an optional field) and saves; undefined for an unknown id. */
  update(id: string, patch: ProfilePatch): Profile | undefined;
  /**
   * Clears the profile's partition, then forgets it. The caller asks first and closes the
   * profile's windows (remove-profile.ts). From the call on the profile reads as gone (`get`,
   * `list`, `lastUsed`, `update`), so nothing opens a window on the partition being cleared; when
   * the clearing fails it is back.
   */
  remove(id: string): Promise<void>;
  /** The last used profile, else the first one. */
  lastUsed(): Profile | undefined;
  setLastUsed(id: string): void;
  /**
   * How the store loaded at start: `loadedCleanly` only when the file was read (or did not exist)
   * and parsed as a whole; `seenIds` every string `id` the file held, kept or dropped, plus the
   * profiles now. The start-up partition sweep trusts nothing else.
   */
  loadReport(): { loadedCleanly: boolean; seenIds: string[] };
}

interface StoreFile {
  version: 1;
  profiles: Profile[];
  lastUsedId: string | null;
}

const OPTIONAL_FIELDS: readonly string[] = ["iconHash", "account", "bounds", "appearance"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function partitionFor(id: string): string {
  return `persist:profile-${id}`;
}

/** The on-disk directory of a profile partition: `Partitions/profile-<uuid>` (ids are UUIDs). */
const PROFILE_PARTITION_DIR =
  /^profile-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface SweepFs {
  readdirSync(path: string): string[];
  rmSync(path: string, o: { recursive: true; force: true }): void;
}

/**
 * The start-up sweep, only after a clean load of the store: every id the file held (kept or
 * dropped) counts as known. Returns the removed names (none when the load was not clean).
 */
export function sweepAfterLoad(
  store: Pick<ProfileStore, "loadReport">,
  o: Omit<Parameters<typeof sweepOrphanPartitions>[0], "knownIds">,
): string[] {
  const report = store.loadReport();
  if (!report.loadedCleanly) return [];
  return sweepOrphanPartitions({ ...o, knownIds: report.seenIds });
}

/**
 * At start, before any partition is loaded: deletes the partition directories of profile ids
 * that are not saved (a provisional profile whose sign-in never completed before the app quit,
 * with the cookies seeded into it). Only directories named like the shell's own profile
 * partitions are touched: never `local`, never anything else. Returns the removed names.
 */
export function sweepOrphanPartitions(o: {
  partitionsDir: string;
  knownIds: Iterable<string>;
  fs: SweepFs;
  join(...parts: string[]): string;
  log?: (message: string, err?: unknown) => void;
}): string[] {
  const known = new Set([...o.knownIds].map((id) => id.toLowerCase()));
  let names: string[];
  try {
    names = o.fs.readdirSync(o.partitionsDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const id = PROFILE_PARTITION_DIR.exec(name)?.[1];
    if (!id || known.has(id.toLowerCase())) continue;
    try {
      o.fs.rmSync(o.join(o.partitionsDir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      o.log?.("could not remove an abandoned partition", err);
    }
  }
  return removed;
}

function parseBounds(v: unknown): ProfileBounds | undefined {
  if (!isRecord(v)) return undefined;
  const { x, y, width, height } = v;
  for (const n of [x, y, width, height])
    if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  if ((width as number) <= 0 || (height as number) <= 0) return undefined;
  return { x, y, width, height } as ProfileBounds;
}

function parseAccount(v: unknown): { name: string; login: string } | undefined {
  if (!isRecord(v) || typeof v.name !== "string" || typeof v.login !== "string") return undefined;
  return { name: v.name, login: v.login };
}

/** A stored profile is used only when it still normalizes to itself. */
function parseProfile(v: unknown): Profile | null {
  if (!isRecord(v)) return null;
  const { id, base, origin, name, iconHash, signedIn } = v;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof base !== "string" || typeof origin !== "string" || typeof name !== "string")
    return null;
  if (iconHash !== undefined && typeof iconHash !== "string") return null;
  const n = normalizeAddress(base);
  if (!n.ok || n.base !== base || n.origin !== origin) return null;
  // Malformed optional fields are dropped, not fatal.
  const account = parseAccount(v.account);
  const bounds = parseBounds(v.bounds);
  const appearance = validAppearance(v.appearance);
  return {
    id,
    base,
    origin,
    name,
    ...(iconHash === undefined ? {} : { iconHash }),
    signedIn: typeof signedIn === "boolean" ? signedIn : true,
    ...(account ? { account } : {}),
    ...(bounds ? { bounds } : {}),
    ...(appearance ? { appearance } : {}),
  };
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Reads the store; an unreadable or corrupt file is moved aside to `<file>.corrupt` (so the next
 * save never overwrites what might be recovered) and reads as empty. A missing file is just empty.
 */
interface ReadResult {
  store: StoreFile;
  /** Read (or missing) and parsed as a whole. */
  clean: boolean;
  /** Every string `id` of the file's entries, valid or dropped. */
  seenIds: string[];
}

function readStore(fs: ProfileFs, file: string): ReadResult {
  const empty: StoreFile = { version: 1, profiles: [], lastUsedId: null };
  const setAside = (): ReadResult => {
    try {
      fs.renameSync(file, `${file}.corrupt`);
    } catch {
      // Nothing more to do: the store still starts empty.
    }
    return { store: empty, clean: false, seenIds: [] };
  };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return isMissing(err) ? { store: empty, clean: true, seenIds: [] } : setAside();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return setAside();
  }
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) return setAside();
  const seenIds = raw.profiles
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : null))
    .filter((id): id is string => id !== null);
  const profiles: Profile[] = [];
  for (const entry of raw.profiles) {
    const p = parseProfile(entry);
    if (p && !profiles.some((q) => q.id === p.id || q.base === p.base)) profiles.push(p);
  }
  const last = typeof raw.lastUsedId === "string" ? raw.lastUsedId : null;
  return {
    store: {
      version: 1,
      profiles,
      lastUsedId: last && profiles.some((p) => p.id === last) ? last : null,
    },
    clean: true,
    seenIds,
  };
}

export function createProfileStore(deps: ProfileStoreDeps): ProfileStore {
  const { fs, file } = deps;
  const loaded = readStore(fs, file);
  let state = loaded.store;
  /** Ids whose removal is clearing the partition: read as gone, never saved as gone yet. */
  const removing = new Set<string>();
  const visible = () => state.profiles.filter((p) => !removing.has(p.id));

  function save(): void {
    fs.mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    // Write and fsync the temporary file before the rename, so a crash leaves the old file or the
    // complete new one, never a truncated one.
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  return {
    list: () => visible().map((p) => ({ ...p })),
    loadReport: () => ({
      loadedCleanly: loaded.clean,
      seenIds: [...new Set([...loaded.seenIds, ...state.profiles.map((p) => p.id)])],
    }),
    get: (id) => {
      const p = visible().find((q) => q.id === id);
      return p && { ...p };
    },
    add(input) {
      const existing = state.profiles.find((p) => p.base === input.base);
      // Its partition is being cleared: it must not come back as this new one.
      if (existing && removing.has(existing.id)) throw new Error("profile is being removed");
      if (existing) return { ...existing };
      const n = normalizeAddress(input.base);
      if (!n.ok || n.base !== input.base || n.origin !== input.origin) {
        throw new Error("profile address is not normalized");
      }
      const id = input.id ?? deps.newId();
      if (!ID.test(id) || state.profiles.some((p) => p.id === id)) {
        throw new Error("profile id is not usable");
      }
      const profile: Profile = { ...input, id, signedIn: input.signedIn ?? false };
      state = { ...state, profiles: [...state.profiles, profile] };
      save();
      return { ...profile };
    },
    update(id, patch) {
      const i = state.profiles.findIndex((p) => p.id === id);
      if (i < 0 || removing.has(id)) return undefined;
      const merged: Record<string, unknown> = { ...state.profiles[i] };
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) merged[k] = v;
        else if (OPTIONAL_FIELDS.includes(k)) delete merged[k];
      }
      // Identity fields are never patched, whatever the caller passes.
      const { id: _i, base, origin } = state.profiles[i] as Profile;
      const next = { ...merged, id, base, origin } as unknown as Profile;
      state = { ...state, profiles: state.profiles.map((p, j) => (j === i ? next : p)) };
      save();
      return { ...next };
    },
    async remove(id) {
      const existing = state.profiles.find((p) => p.id === id);
      if (!existing || removing.has(id)) return;
      removing.add(id);
      try {
        const session = deps.sessionFor(partitionFor(id));
        await session.clearStorageData();
        await session.clearCache?.();
      } finally {
        removing.delete(id);
      }
      state = {
        ...state,
        profiles: state.profiles.filter((p) => p.id !== id),
        lastUsedId: state.lastUsedId === id ? null : state.lastUsedId,
      };
      save();
    },
    lastUsed() {
      const shown = visible();
      const p = shown.find((q) => q.id === state.lastUsedId) ?? shown[0];
      return p && { ...p };
    },
    setLastUsed(id) {
      if (state.lastUsedId === id || !visible().some((p) => p.id === id)) return;
      state = { ...state, lastUsedId: id };
      save();
    },
  };
}
