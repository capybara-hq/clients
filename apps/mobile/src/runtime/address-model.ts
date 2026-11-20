// The address page's state machine (src/local/address/address.ts renders it): discovery of what
// the person typed, the locked-preset refusal, and the deployment's name and icon.
import { type Meta, normalizeAddress } from "@capybara-hq/shell";
import { type AddressErrorKind, discover, type HttpGetPort } from "./discovery.ts";

export interface FoundDeployment {
  base: string;
  name: string | null;
  iconUrl: string | null;
}

export type AddressState =
  | { phase: "idle" }
  | { phase: "checking"; host: string }
  | { phase: "found"; found: FoundDeployment }
  | { phase: "error"; error: AddressErrorKind; host: string };

export interface AddressModel {
  state(): AddressState;
  subscribe(listener: (state: AddressState) => void): () => void;
  submit(input: string): Promise<void>;
  reset(): void;
}

/** `meta.icons.app` (else `meta.icon`) resolved against the base; only http(s) URLs. */
export function resolveIcon(base: string, meta: Meta): string | null {
  const icon = meta.icons?.app ?? meta.icon;
  if (!icon) return null;
  try {
    const url = new URL(icon, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function hostOf(input: string): string {
  const a = normalizeAddress(input);
  return a.ok ? new URL(a.origin).host : input.trim();
}

export function createAddressModel(deps: {
  httpGet: HttpGetPort;
  /** The only base the page accepts (a locked preset), or null. */
  lockedBase: string | null;
}): AddressModel {
  let state: AddressState = { phase: "idle" };
  let seq = 0;
  const listeners = new Set<(s: AddressState) => void>();
  const set = (s: AddressState) => {
    state = s;
    for (const l of [...listeners]) l(s);
  };
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reset() {
      seq++;
      set({ phase: "idle" });
    },
    async submit(input) {
      const mine = ++seq;
      const host = hostOf(input);
      const typed = normalizeAddress(input);
      set({ phase: "checking", host });
      if (deps.lockedBase !== null && !(typed.ok && typed.base === deps.lockedBase)) {
        set({ phase: "error", error: "locked", host });
        return;
      }
      const result = await discover(input, { httpGet: deps.httpGet });
      if (mine !== seq) return;
      if ("error" in result) {
        set({ phase: "error", error: result.error, host });
        return;
      }
      set({
        phase: "found",
        found: {
          base: result.base,
          name: result.meta.name,
          iconUrl: resolveIcon(result.base, result.meta),
        },
      });
    },
  };
}

/** The catalog key of an error; `sign_in_unavailable` keeps its mobile copy. */
export function errorKey(error: AddressErrorKind): string {
  return error === "sign_in_unavailable"
    ? "address.error.sign_in_unavailable_mobile"
    : `address.error.${error}`;
}
