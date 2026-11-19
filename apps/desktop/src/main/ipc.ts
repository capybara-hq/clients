// The page boundary on the main side (mobile spec §9.4): every Shell environment message is checked
// against the calling frame, capabilities are a registry of named functions (nothing generic), and
// confirming calls need a user activation and run one at a time per profile; activation-only calls
// need the activation alone. Event subscriptions (`device@1.onStatus`) are checked like calls and
// delivered only to the subscribing document while it is the profile's top frame.
import type { ShellCallError } from "@capybara-hq/plugin-sdk";
import {
  type CapabilityDescriptors,
  type Controls,
  DOC_ID_PATTERN,
  type Insets,
  SHELL_CALL_ERRORS,
  SHELL_CHANNELS,
  type ShellCallRequest,
  type ShellCallResult,
  type ShellEventMessage,
  type ShellInit,
  type ShellPlatform,
  type ShellSubscribeRequest,
} from "../shared/protocol.ts";
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

/**
 * Given to every call: `confirm(run)` takes the profile's confirmation slot (a user activation and
 * one at a time, mobile spec §9.4) around `run`, for a function that decides only after reading
 * state whether it needs a native confirmation (a widening `requestCeiling`). It rejects with
 * `{ code: "no_activation" | "busy" }`; inside a statically confirming call it reuses that slot.
 */
export interface ConfirmScope {
  confirm<T>(run: () => Promise<T>): Promise<T>;
}

// biome-ignore lint/suspicious/noExplicitAny: capability functions validate their own arguments.
export type CapabilityFn<C> = (ctx: C & ConfirmScope, ...args: any[]) => unknown;

/** An event of a capability: starts delivering payloads to `emit`; answers how to stop. */
export type EventSource<C> = (ctx: C, emit: (payload: unknown) => void) => () => void;

export interface CapabilityOptions<C = CallContext> {
  /** Functions that raise a native confirmation: activation and one-at-a-time gate. */
  confirming?: string[];
  /**
   * Functions that need a user activation but confirm nothing natively, so they take no slot
   * (`signIn@1.start`, spec §8: it grants the page nothing).
   */
  activation?: string[];
  /** Whether the profile is offered this capability now (`device@1` appears later). */
  available?: (profile: Profile) => boolean;
  /** Event names and their sources; the page gets a subscribe function for each. */
  events?: Record<string, EventSource<C>>;
}

interface Registered<C> {
  fns: Map<string, CapabilityFn<C>>;
  events: Map<string, EventSource<C>>;
  confirming: Set<string>;
  activation: Set<string>;
  available: (profile: Profile) => boolean;
}

export interface ShellBridgeDeps<C extends CallContext> {
  /** The window and profile of a sender `webContents`; undefined for anything else. */
  resolveSender(sender: unknown): C | undefined;
  stateFor(target: C): { insets: Insets; controls: Controls | null };
  platform: ShellPlatform;
  shellVersion: string;
  /**
   * Sends one event message to the target's window, only while its top frame is on the profile
   * origin.
   */
  sendEvent?(target: C, message: ShellEventMessage): unknown;
}

export interface IpcMainLike {
  on(
    channel: string,
    listener: (event: IpcEventLike & { returnValue?: unknown }, raw?: unknown) => void,
  ): unknown;
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

function isSubscribeRequest(v: unknown): v is ShellSubscribeRequest {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.event === "string" &&
    Number.isSafeInteger(r.id) &&
    (r.id as number) > 0 &&
    typeof r.doc === "string" &&
    DOC_ID_PATTERN.test(r.doc)
  );
}

function contentsIdOf(sender: unknown): number | undefined {
  if (typeof sender !== "object" || sender === null) return undefined;
  const id = (sender as { id?: unknown }).id;
  return typeof id === "number" ? id : undefined;
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
  /** Per webContents: the document subscribed now and its subscriptions (id → stop). */
  const subscriptions = new Map<number, { doc: string; stops: Map<number, () => void> }>();

  function dropSubscriptions(contentsId: number): void {
    const entry = subscriptions.get(contentsId);
    if (!entry) return;
    subscriptions.delete(contentsId);
    for (const stop of entry.stops.values()) stop();
  }

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

  function describeEvents(profile: Profile): CapabilityDescriptors {
    const out: CapabilityDescriptors = {};
    for (const [key, reg] of registry) {
      if (reg.events.size > 0 && reg.available(profile)) out[key] = [...reg.events.keys()];
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
      opts: CapabilityOptions<C> = {},
    ): void {
      if (registry.has(key)) throw new Error(`capability ${key} is already registered`);
      const fns = new Map(Object.entries(impl).filter(([, f]) => typeof f === "function"));
      const events = new Map(
        Object.entries(opts.events ?? {}).filter(([, f]) => typeof f === "function"),
      );
      for (const name of events.keys()) {
        if (fns.has(name)) throw new Error(`${key}.${name} is both a function and an event`);
      }
      const confirming = new Set(opts.confirming ?? []);
      const activation = new Set(opts.activation ?? []);
      for (const name of [...confirming, ...activation]) {
        if (!fns.has(name)) throw new Error(`${key}.${name} is not a function of the capability`);
      }
      registry.set(key, {
        fns,
        events,
        confirming,
        activation,
        available: opts.available ?? (() => true),
      });
    },

    describe,
    describeEvents,
    dropSubscriptions,

    /** Sync init at preload start: the environment values, or null for any other frame. */
    handleInit(event: IpcEventLike): ShellInit | null {
      const t = target(event);
      if (!t) return null;
      const events = describeEvents(t.profile);
      return {
        origin: t.profile.origin,
        platform: deps.platform,
        shellVersion: deps.shellVersion,
        ...deps.stateFor(t),
        capabilities: describe(t.profile),
        ...(Object.keys(events).length > 0 ? { events } : {}),
      };
    },

    async handleCall(event: IpcEventLike, raw: unknown): Promise<ShellCallResult> {
      const t = target(event);
      if (!t || !isCallRequest(raw)) return FAILED;
      const reg = registry.get(raw.key);
      if (!reg?.available(t.profile)) return FAILED;
      const fn = reg.fns.get(raw.fn);
      if (!fn) return FAILED;
      if (reg.activation.has(raw.fn) && !raw.activation)
        return { ok: false, code: "no_activation" };
      const confirming = reg.confirming.has(raw.fn);
      if (confirming) {
        const decision = gate.isConfirmingCallAllowed(t.profile.id, raw.activation);
        if (decision !== "ok") return { ok: false, code: decision };
      }
      // The activation was read when the page made this call; a later confirm uses that reading.
      let held = confirming;
      const activation = raw.activation;
      const profileId = t.profile.id;
      const scope: ConfirmScope = {
        async confirm(run) {
          if (held) return run();
          const decision = gate.isConfirmingCallAllowed(profileId, activation);
          if (decision !== "ok") throw { code: decision };
          held = true;
          try {
            return await run();
          } finally {
            held = false;
            gate.release(profileId);
          }
        },
      };
      try {
        return { ok: true, value: await fn({ ...t, ...scope }, ...raw.args) };
      } catch (err) {
        return { ok: false, code: toCode(err) };
      } finally {
        if (confirming) gate.release(profileId);
      }
    },

    /**
     * Starts one subscription for the calling document: refused for any frame `handleCall` would
     * refuse, an event the capability does not have, or an id in use. A subscription from a new
     * document of the same window ends the previous document's.
     */
    handleSubscribe(event: IpcEventLike, raw: unknown): boolean {
      const t = target(event);
      const contentsId = contentsIdOf(event.sender);
      if (!t || contentsId === undefined || !isSubscribeRequest(raw)) return false;
      const reg = registry.get(raw.key);
      if (!reg?.available(t.profile)) return false;
      const source = reg.events.get(raw.event);
      if (!source) return false;
      let entry = subscriptions.get(contentsId);
      if (entry && entry.doc !== raw.doc) {
        dropSubscriptions(contentsId);
        entry = undefined;
      }
      if (!entry) {
        entry = { doc: raw.doc, stops: new Map() };
        subscriptions.set(contentsId, entry);
      }
      if (entry.stops.has(raw.id)) return false;
      const { doc, id } = raw;
      let active = true;
      let stop: () => void;
      try {
        stop = source(t, (payload) => {
          if (active) deps.sendEvent?.(t, { doc, id, payload });
        });
      } catch {
        return false;
      }
      entry.stops.set(id, () => {
        active = false;
        stop();
      });
      return true;
    },

    handleUnsubscribe(event: IpcEventLike, raw: unknown): void {
      const contentsId = contentsIdOf(event.sender);
      if (contentsId === undefined || typeof raw !== "object" || raw === null) return;
      const { id, doc } = raw as Record<string, unknown>;
      const entry = subscriptions.get(contentsId);
      if (!entry || entry.doc !== doc || typeof id !== "number") return;
      const stop = entry.stops.get(id);
      entry.stops.delete(id);
      stop?.();
    },

    install(ipcMain: IpcMainLike): void {
      ipcMain.on(SHELL_CHANNELS.init, (event) => {
        event.returnValue = bridge.handleInit(event);
      });
      ipcMain.handle(SHELL_CHANNELS.call, (event, raw) => bridge.handleCall(event, raw));
      ipcMain.handle(SHELL_CHANNELS.subscribe, (event, raw) => bridge.handleSubscribe(event, raw));
      ipcMain.on(SHELL_CHANNELS.unsubscribe, (event, raw) => bridge.handleUnsubscribe(event, raw));
    },
  };
  return bridge;
}

export type ShellBridge<C extends CallContext> = ReturnType<typeof createShellBridge<C>>;
