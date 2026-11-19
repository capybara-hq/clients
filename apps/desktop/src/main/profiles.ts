// Profiles: one per deployment, each with its own session partition (spec §6.3). Stored as JSON in
// userData with atomic writes; a corrupt file reads as empty and never stops the app.
import { dirname } from "node:path";
import { normalizeAddress } from "@capybara-hq/shell";

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
}

export type NewProfile = Omit<Profile, "id">;

export interface ProfileFs {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
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
  /** Clears the profile's partition, then forgets it. */
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

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function partitionFor(id: string): string {
  return `persist:profile-${id}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A stored profile is used only when it still normalizes to itself. */
function parseProfile(v: unknown): Profile | null {
  if (!isRecord(v)) return null;
  const { id, base, origin, name, iconHash } = v;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof base !== "string" || typeof origin !== "string" || typeof name !== "string")
    return null;
  if (iconHash !== undefined && typeof iconHash !== "string") return null;
  const n = normalizeAddress(base);
  if (!n.ok || n.base !== base || n.origin !== origin) return null;
  return { id, base, origin, name, ...(iconHash === undefined ? {} : { iconHash }) };
}

function readStore(fs: ProfileFs, file: string): StoreFile {
  const empty: StoreFile = { version: 1, profiles: [], lastUsedId: null };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return empty;
  }
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) return empty;
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
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
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
      const id = deps.newId();
      if (!ID.test(id) || state.profiles.some((p) => p.id === id)) {
        throw new Error("profile id is not usable");
      }
      const profile: Profile = { id, ...input };
      state = { ...state, profiles: [...state.profiles, profile] };
      save();
      return { ...profile };
    },
    async remove(id) {
      if (!state.profiles.some((p) => p.id === id)) return;
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
