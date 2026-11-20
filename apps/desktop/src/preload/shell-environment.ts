// The Shell environment in the deployment window (mobile spec §9.1, §9.4). The preload runs in the
// isolated world of every document the window loads; it asks main for the environment, re-checks
// the frame and the origin itself, and installs `window.capybaraShell` in the page's world.
// The subpath keeps the preload bundle to this one module (the installer must stay self-contained).
import { installShellEnvironment, type ShellBridge } from "@capybara-hq/shell/install-shell";
import {
  type CapabilityDescriptors,
  DOC_ID_PATTERN,
  SHELL_CALL_ERRORS,
  SHELL_CHANNELS,
  type ShellCallResult,
  type ShellInit,
  type ShellState,
} from "../shared/protocol.ts";

function isShellInit(v: unknown): v is ShellInit {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const caps = r.capabilities;
  return (
    typeof r.origin === "string" &&
    typeof r.platform === "string" &&
    typeof r.shellVersion === "string" &&
    typeof r.insets === "object" &&
    r.insets !== null &&
    (r.controls === null || typeof r.controls === "object") &&
    isDescriptors(caps) &&
    (r.events === undefined || isDescriptors(r.events))
  );
}

function isDescriptors(v: unknown): v is CapabilityDescriptors {
  return (
    typeof v === "object" && v !== null && Object.values(v).every((names) => Array.isArray(names))
  );
}

function isEventMessage(v: unknown): v is { doc: string; id: number; payload: unknown } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.doc === "string" && typeof r.id === "number";
}

function isCallResult(v: unknown): v is ShellCallResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.ok === true) return true;
  return r.ok === false && SHELL_CALL_ERRORS.includes(r.code as never);
}

export interface ShellPreloadDeps {
  ipcRenderer: {
    sendSync(channel: string): unknown;
    invoke(channel: string, payload: unknown): Promise<unknown>;
    send(channel: string, payload: unknown): void;
    on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  };
  /** A fresh random id for this document (`crypto.randomUUID()`). */
  randomId(): string;
  contextBridge: {
    executeInMainWorld(script: { func: (...a: never[]) => unknown; args: unknown[] }): unknown;
  };
  location: { origin: string };
  /**
   * `window.origin`: "null" for a document with an opaque origin (a sandbox CSP) even though its
   * URL, and so `location.origin`, is the profile's.
   */
  windowOrigin: string;
  /** `window.top === window`. */
  isTopFrame: boolean;
  /** `navigator.userActivation.isActive`, read in the isolated world the page cannot patch. */
  userActivation(): boolean;
}

/**
 * Installs the Shell environment when this document is the top frame and main answers for the
 * same origin the document is on. Returns whether it installed. Runs again for every document,
 * so an OAuth round trip off the origin and back is re-checked on each load.
 */
export function bootShellPreload(deps: ShellPreloadDeps): boolean {
  if (!deps.isTopFrame) return false;
  if (deps.windowOrigin === "null" || deps.windowOrigin !== deps.location.origin) return false;
  let init: unknown;
  try {
    init = deps.ipcRenderer.sendSync(SHELL_CHANNELS.init);
  } catch {
    return false;
  }
  if (!isShellInit(init) || init.origin !== deps.location.origin) return false;

  // This document's subscriptions: main sends each event with the document id and the id.
  const doc = deps.randomId();
  if (!DOC_ID_PATTERN.test(doc)) return false;
  const listeners = new Map<number, (payload: unknown) => void>();
  let nextId = 1;
  let listening = false;
  // A new document of this window: main ends what an earlier document subscribed (IPC from one
  // renderer stays in order, so this arrives before any subscription of this document).
  deps.ipcRenderer.send(SHELL_CHANNELS.unsubscribe, { doc });

  const bridge: ShellBridge = {
    async call(key, fn, args) {
      const activation = deps.userActivation();
      try {
        const result = await deps.ipcRenderer.invoke(SHELL_CHANNELS.call, {
          key,
          fn,
          args,
          activation,
        });
        return isCallResult(result) ? result : { ok: false, code: "failed" };
      } catch {
        return { ok: false, code: "failed" };
      }
    },
    onChange(listener) {
      deps.ipcRenderer.on(SHELL_CHANNELS.change, (_event, state) => listener(state as ShellState));
    },
    subscribe(key, event, listener) {
      const id = nextId++;
      listeners.set(id, listener);
      if (!listening) {
        listening = true;
        deps.ipcRenderer.on(SHELL_CHANNELS.event, (_event, message) => {
          if (!isEventMessage(message) || message.doc !== doc) return;
          listeners.get(message.id)?.(message.payload);
        });
      }
      const refused = () => {
        listeners.delete(id);
      };
      deps.ipcRenderer.invoke(SHELL_CHANNELS.subscribe, { key, event, id, doc }).then((ok) => {
        if (ok !== true) refused();
      }, refused);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        listeners.delete(id);
        deps.ipcRenderer.send(SHELL_CHANNELS.unsubscribe, { id, doc });
      };
    },
  };
  deps.contextBridge.executeInMainWorld({
    func: installShellEnvironment,
    args: [{ ...init, kind: "desktop" as const }, bridge],
  });
  return true;
}
