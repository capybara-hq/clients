// The capability registry (mobile spec §5, decision 5). Native gates frame and origin first; the
// registry re-checks the origin against the profile, then validates the call, gates user
// activation and one dialog per profile for confirming functions, and runs the implementation.
// Capabilities are named functions only: nothing generic crosses from the page.

import { createDialogGate } from "./dialog-gate.ts";
import type { HostPort } from "./host-port.ts";
import {
  type CallContext,
  isShellCallMessage,
  type ProfileRef,
  SHELL_CALL_ERRORS,
  type ShellCallError,
  type ShellCallMessage,
  type ShellCallResult,
} from "./protocol.ts";

export interface CapabilityImpl<P extends ProfileRef = ProfileRef> {
  /**
   * Named functions. `ctx.docId` and `ctx.activation` are page-asserted: never authorize on them.
   * A function resolving `undefined` answers `null` (the value crosses JSON).
   */
  functions: Record<string, (ctx: CallContext<P>, ...args: unknown[]) => Promise<unknown>>;
  events?: readonly string[];
  /**
   * Need a user activation and the per-profile dialog gate (`busy`). A confirming function holds
   * the profile's slot until it settles, so it must settle (reject with `cancelled`) when its
   * document ends or its dialog is dismissed; native also expires an unanswered call.
   */
  confirming?: readonly string[];
}

export interface CapabilityRegistry<P extends ProfileRef = ProfileRef> {
  register(key: string, impl: CapabilityImpl<P>, opts?: { available?(profile: P): boolean }): void;
  descriptors(profile: P): {
    capabilities: Record<string, string[]>;
    events: Record<string, string[]>;
  };
  dispatch(msg: ShellCallMessage): Promise<ShellCallResult>;
  emit(profileId: string, key: string, event: string, payload: unknown): void;
}

/** The part of the profile store the registry reads (Task 14's `ProfileStore` satisfies it). */
export interface ProfileLookup<P extends ProfileRef> {
  list(): P[];
}

const FAILED: ShellCallResult = { ok: false, code: "failed" };

function toCode(err: unknown): ShellCallError {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (SHELL_CALL_ERRORS.includes(code as ShellCallError)) return code as ShellCallError;
  }
  return "failed";
}

interface Registered<P extends ProfileRef> {
  impl: CapabilityImpl<P>;
  available: (profile: P) => boolean;
}

export function createRegistry<P extends ProfileRef>(deps: {
  host: HostPort;
  profiles: ProfileLookup<P>;
}): CapabilityRegistry<P> {
  const registry = new Map<string, Registered<P>>();
  const gate = createDialogGate();

  const profileById = (id: string) => deps.profiles.list().find((p) => p.id === id);
  const offered = (key: string, profile: P) => {
    const entry = registry.get(key);
    if (!entry) return undefined;
    try {
      return entry.available(profile) ? entry : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    register(key, impl, opts) {
      registry.set(key, { impl, available: opts?.available ?? (() => true) });
    },

    descriptors(profile) {
      const capabilities: Record<string, string[]> = {};
      const events: Record<string, string[]> = {};
      for (const key of registry.keys()) {
        const entry = offered(key, profile);
        if (!entry) continue;
        capabilities[key] = Object.keys(entry.impl.functions);
        if (entry.impl.events && entry.impl.events.length > 0) {
          events[key] = [...entry.impl.events];
        }
      }
      return { capabilities, events };
    },

    async dispatch(msg) {
      if (!isShellCallMessage(msg)) return FAILED;
      const profile = profileById(msg.profileId);
      // Native already dropped other frames and origins; this is the second check, not the gate.
      if (!profile || msg.origin !== profile.origin) return FAILED;
      const entry = offered(msg.key, profile);
      if (!entry || !Object.hasOwn(entry.impl.functions, msg.fn)) return FAILED;
      const fn = entry.impl.functions[msg.fn];
      if (typeof fn !== "function") return FAILED;
      const ctx: CallContext<P> = {
        profile,
        origin: msg.origin,
        docId: msg.docId,
        activation: msg.activation,
      };
      const confirming = entry.impl.confirming?.includes(msg.fn) ?? false;
      if (confirming) {
        const decision = gate.enter(profile.id, msg.activation);
        if (decision !== "ok") return { ok: false, code: decision };
      }
      try {
        const value = await fn(ctx, ...msg.args);
        // JSON drops an undefined property: the page would see `{ ok: true }` and fail it.
        return { ok: true, value: value === undefined ? null : value };
      } catch (err) {
        return { ok: false, code: toCode(err) };
      } finally {
        if (confirming) gate.release(profile.id);
      }
    },

    emit(profileId, key, event, payload) {
      const profile = profileById(profileId);
      if (!profile) return;
      const entry = offered(key, profile);
      if (!entry?.impl.events?.includes(event)) return;
      deps.host.event(profileId, key, event, payload).catch(() => {});
    },
  };
}

/** Answers every call native forwards; returns how to stop. */
export function serveCalls<P extends ProfileRef>(
  host: HostPort,
  registry: CapabilityRegistry<P>,
): () => void {
  return host.onCall((msg) => {
    registry
      .dispatch(msg)
      .then((result) => host.reply(msg.profileId, msg.callId, result))
      .catch(() => {});
  });
}
