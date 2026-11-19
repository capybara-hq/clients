// The page boundary on the main side (mobile spec §9.4): every Shell environment message is checked
// against the calling frame, capabilities are a registry of named functions (nothing generic), and
// confirming calls need a user activation and run one at a time per profile.
import {
  type CapabilityDescriptors,
  type Controls,
  type Insets,
  SHELL_CHANNELS,
  type ShellCallRequest,
  type ShellCallResult,
  type ShellInit,
  type ShellPlatform,
} from "../shared/protocol.ts";
import { SHELL_CALL_ERRORS, type ShellCallError } from "../shared/sdk-shell-types.ts";
import type { Profile } from "./profiles.ts";

export interface FrameLike {
  origin: string;
  parent: unknown | null;
}

export interface IpcEventLike {
  sender: unknown;
  senderFrame?: FrameLike | null | undefined;
}

/**
 * True only for the top frame (`parent === null`) whose origin is exactly the profile origin. A
 * missing or destroyed frame (Electron gives null) is refused.
 */
export function guardIpc(
  event: { senderFrame?: FrameLike | null | undefined },
  profile: Profile | undefined,
): boolean {
  if (!profile) return false;
  let frame: FrameLike | null | undefined;
  try {
    // Reading a destroyed frame's properties throws in Electron.
    frame = event.senderFrame;
    if (!frame) return false;
    return frame.parent === null && frame.origin === profile.origin;
  } catch {
    return false;
  }
}

export type ConfirmDecision = "ok" | "busy" | "no_activation";

export interface ConfirmGate {
  /** "ok" takes the profile's slot: the caller must `release` it when the call settles. */
  isConfirmingCallAllowed(profileId: string, activationActive: boolean): ConfirmDecision;
  release(profileId: string): void;
}

export function createConfirmGate(): ConfirmGate {
  const busy = new Set<string>();
  return {
    isConfirmingCallAllowed(profileId, activationActive) {
      if (!activationActive) return "no_activation";
      if (busy.has(profileId)) return "busy";
      busy.add(profileId);
      return "ok";
    },
    release(profileId) {
      busy.delete(profileId);
    },
  };
}

/** What a capability function receives first: the calling profile, never one named by the page. */
export interface CallContext {
  profile: Profile;
}

// biome-ignore lint/suspicious/noExplicitAny: capability functions validate their own arguments.
export type CapabilityFn<C> = (ctx: C, ...args: any[]) => unknown;

export interface CapabilityOptions {
  /** Functions that raise a native confirmation: activation and one-at-a-time gate. */
  confirming?: string[];
  /** Whether the profile is offered this capability now (`device@1` appears later). */
  available?: (profile: Profile) => boolean;
}

interface Registered<C> {
  fns: Map<string, CapabilityFn<C>>;
  confirming: Set<string>;
  available: (profile: Profile) => boolean;
}

export interface ShellBridgeDeps<C extends CallContext> {
  /** The window and profile of a sender `webContents`; undefined for anything else. */
  resolveSender(sender: unknown): C | undefined;
  stateFor(target: C): { insets: Insets; controls: Controls | null };
  platform: ShellPlatform;
  shellVersion: string;
}

export interface IpcMainLike {
  on(channel: string, listener: (event: IpcEventLike & { returnValue?: unknown }) => void): unknown;
  handle(channel: string, listener: (event: IpcEventLike, raw: unknown) => unknown): unknown;
}

function isCallRequest(v: unknown): v is ShellCallRequest {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.fn === "string" &&
    Array.isArray(r.args) &&
    typeof r.activation === "boolean"
  );
}

function toCode(err: unknown): ShellCallError {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (SHELL_CALL_ERRORS.includes(code as ShellCallError)) return code as ShellCallError;
  }
  return "failed";
}

const FAILED: ShellCallResult = { ok: false, code: "failed" };

export function createShellBridge<C extends CallContext>(deps: ShellBridgeDeps<C>) {
  const registry = new Map<string, Registered<C>>();
  const gate = createConfirmGate();

  function target(event: IpcEventLike): C | undefined {
    const t = deps.resolveSender(event.sender);
    return t && guardIpc(event, t.profile) ? t : undefined;
  }

  function describe(profile: Profile): CapabilityDescriptors {
    const out: CapabilityDescriptors = {};
    for (const [key, reg] of registry) {
      if (reg.available(profile)) out[key] = [...reg.fns.keys()];
    }
    return out;
  }

  const bridge = {
    /**
     * Registers `key` (`name@major`). The preload only ever learns the key and the function names;
     * each function gets the caller's context first, then the page's arguments.
     */
    registerCapability(
      key: string,
      impl: Record<string, CapabilityFn<C>>,
      opts: CapabilityOptions = {},
    ): void {
      if (registry.has(key)) throw new Error(`capability ${key} is already registered`);
      const fns = new Map(Object.entries(impl).filter(([, f]) => typeof f === "function"));
      const confirming = new Set(opts.confirming ?? []);
      for (const name of confirming) {
        if (!fns.has(name)) throw new Error(`${key}.${name} is not a function of the capability`);
      }
      registry.set(key, { fns, confirming, available: opts.available ?? (() => true) });
    },

    describe,

    /** Sync init at preload start: the environment values, or null for any other frame. */
    handleInit(event: IpcEventLike): ShellInit | null {
      const t = target(event);
      if (!t) return null;
      return {
        origin: t.profile.origin,
        platform: deps.platform,
        shellVersion: deps.shellVersion,
        ...deps.stateFor(t),
        capabilities: describe(t.profile),
      };
    },

    async handleCall(event: IpcEventLike, raw: unknown): Promise<ShellCallResult> {
      const t = target(event);
      if (!t || !isCallRequest(raw)) return FAILED;
      const reg = registry.get(raw.key);
      if (!reg?.available(t.profile)) return FAILED;
      const fn = reg.fns.get(raw.fn);
      if (!fn) return FAILED;
      const confirming = reg.confirming.has(raw.fn);
      if (confirming) {
        const decision = gate.isConfirmingCallAllowed(t.profile.id, raw.activation);
        if (decision !== "ok") return { ok: false, code: decision };
      }
      try {
        return { ok: true, value: await fn(t, ...raw.args) };
      } catch (err) {
        return { ok: false, code: toCode(err) };
      } finally {
        if (confirming) gate.release(t.profile.id);
      }
    },

    install(ipcMain: IpcMainLike): void {
      ipcMain.on(SHELL_CHANNELS.init, (event) => {
        event.returnValue = bridge.handleInit(event);
      });
      ipcMain.handle(SHELL_CHANNELS.call, (event, raw) => bridge.handleCall(event, raw));
    },
  };
  return bridge;
}

export type ShellBridge<C extends CallContext> = ReturnType<typeof createShellBridge<C>>;
