// The address page's main side (spec §6.1, Ruling R3): normalization and discovery run here, and
// the page gets a narrow IPC of its own (init, submit, open) checked against the calling frame. The
// page never chooses what is saved: `open` uses what main discovered for that window.
import { fetchMeta, type Locale, normalizeAddress, t } from "@capybara-hq/shell";
import {
  ADDRESS_CHANNELS,
  ADDRESS_ORIGIN,
  type AddressInit,
  type AddressOpenResult,
  type AddressResult,
} from "../shared/protocol.ts";
import type { FrameLike, IpcMainLike } from "./ipc.ts";
import type { NewProfile, Profile } from "./profiles.ts";
import { webContentsId } from "./windows.ts";

/** `app.getLocale()` → the catalog: zh* is zh, everything else en. */
export function localeFrom(appLocale: string): Locale {
  return appLocale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** The strings the address page shows; nothing else of the catalog is sent to it. */
export const ADDRESS_STRING_KEYS = [
  "address.title",
  "address.label",
  "address.placeholder",
  "address.continue",
  "address.checking",
  "address.open",
  "address.change",
  "address.error.invalid",
  "address.error.insecure",
  "address.error.unreachable",
  "address.error.not_capybara",
  "address.error.too_old",
  "address.error.failed",
] as const;

export const ICON_MAX_BYTES = 256 * 1024;
const ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ICON_TIMEOUT_MS = 10_000;
const MAX_ADDRESS_LENGTH = 2048;
const MAX_NAME_LENGTH = 200;

export interface Discovery {
  result: AddressResult;
  /** Present only when `result.ok`: what `open` saves. */
  candidate?: NewProfile;
}

async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The meta icon as a data: URL, so the page needs no network. Only from the deployment's own
 * origin, never redirected, PNG / JPEG / WebP (no SVG), at most 256 KiB; anything else is null.
 */
async function fetchIcon(iconUrl: URL, fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn(iconUrl.href, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ICON_TYPES.has(type)) return null;
    const body = await readCapped(res, ICON_MAX_BYTES);
    if (!body || body.byteLength === 0) return null;
    return `data:${type};base64,${Buffer.from(body).toString("base64")}`;
  } catch {
    return null;
  }
}

export async function discoverDeployment(
  input: string,
  deps: { fetch: typeof fetch },
): Promise<Discovery> {
  const address = normalizeAddress(input);
  if (!address.ok) return { result: { ok: false, error: address.reason } };
  const meta = await fetchMeta(address.base, deps.fetch);
  if ("error" in meta) return { result: { ok: false, error: meta.error } };

  const host = new URL(address.origin).host;
  const named = meta.name?.trim().slice(0, MAX_NAME_LENGTH);
  const name = named ? named : host;

  let icon: string | null = null;
  let iconHash: string | undefined;
  if (meta.icon) {
    let iconUrl: URL | null = null;
    try {
      iconUrl = new URL(meta.icon, `${address.base}/`);
    } catch {
      iconUrl = null;
    }
    if (iconUrl && iconUrl.origin === address.origin) {
      icon = await fetchIcon(iconUrl, deps.fetch);
      const v = iconUrl.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{1,128}$/.test(v)) iconHash = v;
    }
  }
  return {
    result: { ok: true, name, host, icon },
    candidate: {
      base: address.base,
      origin: address.origin,
      name,
      ...(iconHash ? { iconHash } : {}),
    },
  };
}

export interface AddressHostDeps {
  discover(input: string): Promise<Discovery>;
  /** True for the webContents of an address window. */
  isAddressSender(sender: unknown): boolean;
  locale: Locale;
  prefillFor(sender: unknown): string | null;
  addProfile(candidate: NewProfile): Profile;
  openProfile(profile: Profile): void;
  closeSender(sender: unknown): void;
}

interface AddressEvent {
  sender: unknown;
  senderFrame?: FrameLike | null | undefined;
}

export function createAddressHost(deps: AddressHostDeps) {
  // Per address window: the latest submit and what it discovered.
  const pending = new Map<number, { seq: number; candidate?: NewProfile }>();

  /** The sender's webContents id when the message comes from an address page's top frame. */
  function allowed(event: AddressEvent): number | undefined {
    const id = webContentsId(event.sender);
    if (id === undefined || !deps.isAddressSender(event.sender)) return undefined;
    try {
      const frame = event.senderFrame;
      return frame && frame.parent === null && frame.origin === ADDRESS_ORIGIN ? id : undefined;
    } catch {
      return undefined;
    }
  }

  const host = {
    handleInit(event: AddressEvent): AddressInit | null {
      if (allowed(event) === undefined) return null;
      const strings: Record<string, string> = {};
      for (const key of ADDRESS_STRING_KEYS) strings[key] = t(deps.locale, key);
      return { locale: deps.locale, strings, prefill: deps.prefillFor(event.sender) };
    },

    async handleSubmit(event: AddressEvent, raw: unknown): Promise<AddressResult> {
      const id = allowed(event);
      if (id === undefined) return { ok: false, error: "failed" };
      if (typeof raw !== "string" || raw.length > MAX_ADDRESS_LENGTH) {
        return { ok: false, error: "invalid" };
      }
      const seq = (pending.get(id)?.seq ?? 0) + 1;
      pending.set(id, { seq });
      let found: Discovery;
      try {
        found = await deps.discover(raw);
      } catch {
        found = { result: { ok: false, error: "failed" } };
      }
      // A later submit supersedes this one.
      if (pending.get(id)?.seq === seq && found.result.ok && found.candidate) {
        pending.set(id, { seq, candidate: found.candidate });
      }
      return found.result;
    },

    async handleOpen(event: AddressEvent): Promise<AddressOpenResult> {
      const id = allowed(event);
      if (id === undefined) return { ok: false, error: "failed" };
      const entry = pending.get(id);
      if (!entry?.candidate) return { ok: false, error: "failed" };
      pending.set(id, { seq: entry.seq });
      try {
        const profile = deps.addProfile(entry.candidate);
        pending.delete(id);
        deps.openProfile(profile);
        deps.closeSender(event.sender);
        return { ok: true };
      } catch {
        return { ok: false, error: "failed" };
      }
    },

    /** Drops what was pending for a closed address window. */
    forget(webContentsId: number): void {
      pending.delete(webContentsId);
    },

    /** How many address windows have something pending (for tests). */
    pendingCount(): number {
      return pending.size;
    },

    install(ipcMain: IpcMainLike): void {
      ipcMain.on(ADDRESS_CHANNELS.init, (event) => {
        event.returnValue = host.handleInit(event);
      });
      ipcMain.handle(ADDRESS_CHANNELS.submit, (event, raw) => host.handleSubmit(event, raw));
      ipcMain.handle(ADDRESS_CHANNELS.open, (event) => host.handleOpen(event));
    },
  };
  return host;
}
