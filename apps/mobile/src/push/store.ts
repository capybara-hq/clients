// The deployment's registration id per profile (core spec §9.3, decision 2): `push@1.registered`
// writes it, `status()` reports it and profile removal deletes it on the deployment first. The
// token itself is never stored: only its SHA-256, enough to tell whether it rotated.
import type { PrefsPort } from "../runtime/profiles.ts";

export interface StoredRegistration {
  /** The deployment's registration id (`POST /api/v1/me/push-registrations` answered it). */
  id: string;
  /** The channel it was registered with. */
  provider: string;
  /** SHA-256 of the token it was registered with, hex. */
  tokenHash: string;
}

export interface RegistrationStore {
  get(profileId: string): StoredRegistration | null;
  set(profileId: string, value: StoredRegistration): Promise<void>;
  clear(profileId: string): Promise<void>;
  /** Whether any profile holds a registration (one OS token serves every profile, decision 6). */
  any(): boolean;
}

/** The preference that holds the map; preload it with the profiles (`preloadPrefs`). */
export const PUSH_REGISTRATIONS_PREF_KEY = "push-registrations";

function isStored(v: unknown): v is StoredRegistration {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" && typeof r.provider === "string" && typeof r.tokenHash === "string"
  );
}

function read(prefs: PrefsPort): Record<string, StoredRegistration> {
  const out: Record<string, StoredRegistration> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(prefs.get(PUSH_REGISTRATIONS_PREF_KEY) ?? "{}");
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [id, v] of Object.entries(parsed)) {
    if (isStored(v)) out[id] = { id: v.id, provider: v.provider, tokenHash: v.tokenHash };
  }
  return out;
}

export function createRegistrationStore(prefs: PrefsPort): RegistrationStore {
  let state = read(prefs);
  // Writes run one after another, each from the state the previous one left, so two profiles
  // written at once never drop each other.
  let queue: Promise<unknown> = Promise.resolve();
  const update = (
    change: (s: Record<string, StoredRegistration>) => Record<string, StoredRegistration> | null,
  ): Promise<void> => {
    const run = queue.then(async () => {
      const next = change(state);
      if (next === null) return;
      await prefs.set(PUSH_REGISTRATIONS_PREF_KEY, JSON.stringify(next));
      state = next;
    });
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    get: (profileId) => {
      const v = Object.hasOwn(state, profileId) ? state[profileId] : undefined;
      return v ? { ...v } : null;
    },
    set: (profileId, value) => update((s) => ({ ...s, [profileId]: { ...value } })),
    clear: (profileId) =>
      update((s) => {
        if (!Object.hasOwn(s, profileId)) return null;
        const { [profileId]: _gone, ...rest } = s;
        return rest;
      }),
    any: () => Object.keys(state).length > 0,
  };
}
