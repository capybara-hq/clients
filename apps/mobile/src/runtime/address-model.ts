// The address page's state machine (src/local/address/address.ts renders it). Discovery itself,
// the locked-preset refusal included, runs in the runtime (address-bridge.ts `answerDiscover`);
// the page reaches it by postMessage, so the model only takes a `discover` function.
import { type Meta, normalizeAddress } from "@capybara-hq/shell";
import type { AddressResult } from "./address-bridge.ts";
import type { AddressErrorKind } from "./discovery.ts";

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

/**
 * `meta.icons.app` (else `meta.icon`) resolved against the base. Only https, or http when the
 * base itself is http (a loopback deployment): an https deployment never shows a plain-http image.
 */
export function resolveIcon(base: string, meta: Meta): string | null {
  const icon = meta.icons?.app ?? meta.icon;
  if (!icon) return null;
  try {
    const url = new URL(icon, base);
    const httpOk = new URL(base).protocol === "http:";
    return url.protocol === "https:" || (httpOk && url.protocol === "http:") ? url.href : null;
  } catch {
    return null;
  }
}

function hostOf(input: string): string {
  const a = normalizeAddress(input);
  return a.ok ? new URL(a.origin).host : input.trim();
}

export function createAddressModel(deps: {
  /** The runtime's discovery (`answerDiscover`, over postMessage in the page). */
  discover(input: string): Promise<AddressResult>;
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
      set({ phase: "checking", host: hostOf(input) });
      const result = await deps.discover(input);
      if (mine !== seq) return;
      set(
        "found" in result ? { phase: "found", found: result.found } : { phase: "error", ...result },
      );
    },
  };
}

/** The catalog key of an error; `sign_in_unavailable` keeps its mobile copy. */
export function errorKey(error: AddressErrorKind): string {
  return error === "sign_in_unavailable"
    ? "address.error.sign_in_unavailable_mobile"
    : `address.error.${error}`;
}
