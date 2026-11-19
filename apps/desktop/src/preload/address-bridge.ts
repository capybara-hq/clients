// The address page bridge, separate from the Electron wiring so it tests without Electron.
import {
  ADDRESS_CHANNELS,
  ADDRESS_HOST,
  type AddressInit,
  type AddressOpenResult,
  type AddressResult,
  APP_SCHEME,
} from "../shared/protocol.ts";

export interface AddressApi {
  locale: "zh" | "en";
  strings: Record<string, string>;
  prefill: string | null;
  submit(address: string): Promise<AddressResult>;
  open(): Promise<AddressOpenResult>;
}

export interface AddressPreloadDeps {
  ipcRenderer: {
    sendSync(channel: string): unknown;
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  };
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  location: { protocol: string; host: string };
  isTopFrame: boolean;
}

function isInit(v: unknown): v is AddressInit {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.locale === "zh" || r.locale === "en") &&
    typeof r.strings === "object" &&
    r.strings !== null &&
    (r.prefill === null || typeof r.prefill === "string")
  );
}

const FAILED = { ok: false, error: "failed" } as const;

/** Exposes `window.capybaraAddress` on the top frame of app://address only. */
export function bootAddressPreload(deps: AddressPreloadDeps): boolean {
  if (!deps.isTopFrame) return false;
  if (deps.location.protocol !== `${APP_SCHEME}:` || deps.location.host !== ADDRESS_HOST) {
    return false;
  }
  let init: unknown;
  try {
    init = deps.ipcRenderer.sendSync(ADDRESS_CHANNELS.init);
  } catch {
    return false;
  }
  if (!isInit(init)) return false;
  const api: AddressApi = {
    locale: init.locale,
    strings: { ...init.strings },
    prefill: init.prefill,
    async submit(address) {
      try {
        return (await deps.ipcRenderer.invoke(
          ADDRESS_CHANNELS.submit,
          String(address),
        )) as AddressResult;
      } catch {
        return FAILED;
      }
    },
    async open() {
      try {
        return (await deps.ipcRenderer.invoke(ADDRESS_CHANNELS.open)) as AddressOpenResult;
      } catch {
        return FAILED;
      }
    },
  };
  deps.contextBridge.exposeInMainWorld("capybaraAddress", api);
  return true;
}
