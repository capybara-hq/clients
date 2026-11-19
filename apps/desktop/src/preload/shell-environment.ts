// The Shell environment in the deployment window (mobile spec §9.1, §9.4). The preload runs in the
// isolated world of every document the window loads; it asks main for the environment, re-checks
// the frame and the origin itself, and installs `window.capybaraShell` in the page's world.
import {
  type CapabilityDescriptors,
  SHELL_CALL_ERRORS,
  SHELL_CHANNELS,
  type ShellCallResult,
  type ShellInit,
  type ShellState,
} from "../shared/protocol.ts";

/** What the page's world gets from the isolated world: two functions, nothing generic. */
export interface ShellBridge {
  call(key: string, fn: string, args: unknown[]): Promise<ShellCallResult>;
  onChange(listener: (state: ShellState) => void): void;
}

/**
 * Runs in the page's world through `contextBridge.executeInMainWorld`, which passes it as source
 * text: it must stay self-contained (no imports, no outer variables). `target` exists for tests;
 * in the page it is `globalThis`.
 *
 * The object is frozen and defined non-writable and non-configurable; `insets`, `controls` and
 * `capabilities` are getters so a `change` listener reads the new values.
 */
export function installShellEnvironment(
  init: ShellInit,
  bridge: ShellBridge,
  target?: object,
): void {
  const host = target === undefined ? globalThis : target;
  const listeners = new Set<() => void>();

  const freezeInsets = (i: ShellInit["insets"]) =>
    Object.freeze({ top: i.top, right: i.right, bottom: i.bottom, left: i.left });
  const freezeControls = (c: ShellInit["controls"]) =>
    c === null ? null : Object.freeze({ x: c.x, y: c.y, width: c.width, height: c.height });
  const buildCapabilities = (descriptors: CapabilityDescriptors) => {
    const out: Record<string, object> = {};
    for (const key of Object.keys(descriptors)) {
      const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const name of descriptors[key] ?? []) {
        fns[name] = (...args: unknown[]) =>
          bridge.call(key, name, args).then((r) => {
            if (r.ok) return r.value;
            const err = new Error(`capybaraShell ${key}.${name}: ${r.code}`) as Error & {
              code: string;
            };
            err.code = r.code;
            throw err;
          });
      }
      out[key] = Object.freeze(fns);
    }
    return Object.freeze(out);
  };

  let insets = freezeInsets(init.insets);
  let controls = freezeControls(init.controls);
  let capabilities = buildCapabilities(init.capabilities);

  const shell = Object.freeze({
    version: 1 as const,
    kind: "desktop" as const,
    platform: init.platform,
    shellVersion: init.shellVersion,
    get insets() {
      return insets;
    },
    get controls() {
      return controls;
    },
    get capabilities() {
      return capabilities;
    },
    on(event: "change", listener: () => void): () => void {
      if (event !== "change" || typeof listener !== "function") return () => {};
      // A wrapper per subscription, so subscribing the same function twice needs two unsubscribes.
      const entry = () => listener();
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  });

  bridge.onChange((state) => {
    insets = freezeInsets(state.insets);
    controls = freezeControls(state.controls);
    capabilities = buildCapabilities(state.capabilities);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        console.error(err);
      }
    }
  });

  Object.defineProperty(host, "capybaraShell", {
    value: shell,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

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
    typeof caps === "object" &&
    caps !== null &&
    Object.values(caps).every((names) => Array.isArray(names))
  );
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
    on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  };
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
  };
  deps.contextBridge.executeInMainWorld({ func: installShellEnvironment, args: [init, bridge] });
  return true;
}
