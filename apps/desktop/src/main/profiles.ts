// Profiles: one per deployment, each with its own session partition (spec §6.3). Stored as JSON in
// userData with atomic writes; a corrupt file reads as empty and never stops the app.
import { dirname } from "node:path";
import { normalizeAddress } from "@capybara-hq/shell";
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
  /** Adds a profile; the same `base` again returns the existing one. */
  add(input: NewProfile): Profile;
  /** Merges `patch` (undefined removes an optional field) and saves; undefined for an unknown id. */
  update(id: string, patch: ProfilePatch): Profile | undefined;
  /**
   * Clears the profile's partition, then forgets it. The caller asks first and closes the
   * profile's windows (remove-profile.ts).
   */
  remove(id: string): Promise<void>;
  /** The last used profile, else the first one. */
  lastUsed(): Profile | undefined;
  setLastUsed(id: string): void;
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
function readStore(fs: ProfileFs, file: string): StoreFile {
  const empty: StoreFile = { version: 1, profiles: [], lastUsedId: null };
  const setAside = () => {
    try {
      fs.renameSync(file, `${file}.corrupt`);
    } catch {
      // Nothing more to do: the store still starts empty.
    }
    return empty;
  };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return isMissing(err) ? empty : setAside();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return setAside();
  }
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) return setAside();
  const profiles: Profile[] = [];
  for (const entry of raw.profiles) {
    const p = parseProfile(entry);
    if (p && !profiles.some((q) => q.id === p.id || q.base === p.base)) profiles.push(p);
  }
  const last = typeof raw.lastUsedId === "string" ? raw.lastUsedId : null;
  return {
    version: 1,
    profiles,
    lastUsedId: last && profiles.some((p) => p.id === last) ? last : null,
  };
}

export function createProfileStore(deps: ProfileStoreDeps): ProfileStore {
  const { fs, file } = deps;
  let state = readStore(fs, file);

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
    list: () => state.profiles.map((p) => ({ ...p })),
    get: (id) => {
      const p = state.profiles.find((q) => q.id === id);
      return p && { ...p };
    },
    add(input) {
      const existing = state.profiles.find((p) => p.base === input.base);
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
      if (i < 0) return undefined;
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
      if (!existing) return;
      const session = deps.sessionFor(partitionFor(id));
      await session.clearStorageData();
      await session.clearCache?.();
      state = {
        ...state,
        profiles: state.profiles.filter((p) => p.id !== id),
        lastUsedId: state.lastUsedId === id ? null : state.lastUsedId,
      };
      save();
    },
    lastUsed() {
      const p = state.profiles.find((q) => q.id === state.lastUsedId) ?? state.profiles[0];
      return p && { ...p };
    },
    setLastUsed(id) {
      if (state.lastUsedId === id || !state.profiles.some((p) => p.id === id)) return;
      state = { ...state, lastUsedId: id };
      save();
    },
  };
}
