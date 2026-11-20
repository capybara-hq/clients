/** What the page's world gets from the isolated world: three functions, nothing generic. */
export interface ShellBridge {
  call(key: string, fn: string, args: unknown[]): Promise<ShellCallResult>;
  onChange(listener: (state: ShellState) => void): void;
  /** Subscribes to one event of a capability; answers how to unsubscribe. */
  subscribe(key: string, event: string, listener: (payload: unknown) => void): () => void;
}

export type ShellCallResult = { ok: true; value: unknown } | { ok: false; code: string };

/** Key -> function names; the page's callers are built from this list and nothing else. */
export type CapabilityDescriptors = Record<string, string[]>;

export interface ShellInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ShellState {
  insets: ShellInsets;
  /** Desktop only: the window controls' rectangle, null when hidden. Absent on mobile. */
  controls?: { x: number; y: number; width: number; height: number } | null;
  capabilities: CapabilityDescriptors;
  /** Key -> event names: each becomes a function that takes a listener and returns an unsubscribe. */
  events?: CapabilityDescriptors;
}

export interface ShellInit extends ShellState {
  /** The profile origin; the shell re-checks it against `location.origin`. */
  origin: string;
  platform: string;
  shellVersion: string;
}

/**
 * Runs in the page's world (the desktop passes it to `contextBridge.executeInMainWorld`, which
 * hands it over as source text): it must stay self-contained, with no imports and no outer
 * variables. `target` exists for tests; in the page it is `globalThis`.
 *
 * The object is frozen and defined non-writable and non-configurable; `insets`, `controls` (desktop
 * only: a mobile shell has no `controls` property) and `capabilities` are getters so a `change`
 * listener reads the new values.
 */
export function installShellEnvironment(
  init: ShellInit & { kind: "desktop" | "mobile" },
  bridge: ShellBridge,
  target?: object,
): void {
  const host = target === undefined ? globalThis : target;
  const listeners = new Set<() => void>();

  type Controls = NonNullable<ShellInit["controls"]>;
  const freezeInsets = (i: ShellInsets) =>
    Object.freeze({ top: i.top, right: i.right, bottom: i.bottom, left: i.left });
  const freezeControls = (c: Controls | null | undefined) =>
    c === null || c === undefined
      ? null
      : Object.freeze({ x: c.x, y: c.y, width: c.width, height: c.height });
  const buildCapabilities = (
    descriptors: CapabilityDescriptors,
    events: CapabilityDescriptors | undefined,
  ) => {
    const out: Record<string, object> = {};
    const keys = new Set([...Object.keys(descriptors), ...Object.keys(events ?? {})]);
    for (const key of keys) {
      const fns: Record<string, (...args: never[]) => unknown> = {};
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
      for (const name of events?.[key] ?? []) {
        fns[name] = (listener: (payload: unknown) => void) => {
          if (typeof listener !== "function") return () => {};
          return bridge.subscribe(key, name, (payload) => {
            try {
              listener(payload);
            } catch (err) {
              console.error(err);
            }
          });
        };
      }
      out[key] = Object.freeze(fns);
    }
    return Object.freeze(out);
  };

  const desktop = init.kind === "desktop";
  let insets = freezeInsets(init.insets);
  let controls = freezeControls(init.controls);
  let capabilities = buildCapabilities(init.capabilities, init.events);

  const shell = {
    version: 1 as const,
    kind: init.kind,
    platform: init.platform,
    shellVersion: init.shellVersion,
    get insets() {
      return insets;
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
  };
  if (desktop) {
    Object.defineProperty(shell, "controls", {
      get: () => controls,
      enumerable: true,
    });
  }
  Object.freeze(shell);

  bridge.onChange((state) => {
    insets = freezeInsets(state.insets);
    if (desktop) controls = freezeControls(state.controls);
    capabilities = buildCapabilities(state.capabilities, state.events);
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
