// The local pages' bridge, separate from the Electron wiring so it tests without Electron. It
// exposes `window.capybaraLocal` (state, onState, act) on the top frame of app://local only.
// Main re-checks every message against the sender; this check only keeps the bridge off
// anything else.
import type { CapybaraLocal, LocalActResult, PageState } from "../shared/local-page.ts";
import { APP_SCHEME, LOCAL_CHANNELS, LOCAL_HOST } from "../shared/protocol.ts";

export interface LocalPreloadDeps {
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  };
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  location: { protocol: string; host: string };
  isTopFrame: boolean;
}

function isState(v: unknown): v is PageState {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.page === "string" && typeof r.appearance === "object" && r.appearance !== null;
}

function isResult(v: unknown): v is LocalActResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.ok === true || (r.ok === false && typeof r.error === "string");
}

export function bootLocalPreload(deps: LocalPreloadDeps): boolean {
  if (!deps.isTopFrame) return false;
  if (deps.location.protocol !== `${APP_SCHEME}:` || deps.location.host !== LOCAL_HOST) {
    return false;
  }
  const listeners = new Set<(state: PageState) => void>();
  deps.ipcRenderer.on(LOCAL_CHANNELS.push, (_event, payload) => {
    if (!isState(payload)) return;
    for (const l of [...listeners]) {
      try {
        l(payload);
      } catch {
        // One page listener failing must not stop the others.
      }
    }
  });
  const api: CapybaraLocal = {
    async state() {
      const s = await deps.ipcRenderer.invoke(LOCAL_CHANNELS.state);
      if (!isState(s)) throw new Error("refused");
      return s;
    },
    onState(cb) {
      if (typeof cb !== "function") return () => undefined;
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async act(action, args) {
      let result: unknown;
      try {
        result = await deps.ipcRenderer.invoke(LOCAL_CHANNELS.act, {
          action: String(action),
          ...(args === undefined ? {} : { args }),
        });
      } catch {
        throw new Error("failed");
      }
      if (!isResult(result)) throw new Error("failed");
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
  };
  deps.contextBridge.exposeInMainWorld("capybaraLocal", api);
  return true;
}
