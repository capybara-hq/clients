// Discovery for the address page and the start route (spec §4.1, §4.2).
//
// The page asks `GET <base>/api/v1/meta` through the native `HttpGet` (ShellPlugin), never through
// the WebView's own fetch: native refuses redirects, caps the wait and the body, and keeps its own
// cookie jar. `fetchMeta` and `normalizeAddress` come from the shell package; this file only
// adapts the native port to the `fetch` shape `fetchMeta` takes.
import { fetchMeta, type Meta, normalizeAddress } from "@capybara-hq/shell";
import type { Brand } from "../../brand.ts";
import type { ProfileStore } from "./profiles.ts";

/** What native `HttpGet` returns. A 3xx status is reported as is: native never follows it. */
export interface HttpGetResult {
  status: number;
  body: string;
  /** The body was cut at the size cap (`HTTP_GET_MAX_BYTES`). */
  truncated?: boolean;
}

/**
 * Native `HttpGet`: one GET with no redirects, a timeout (`HTTP_GET_TIMEOUT_MS`) and a body cap.
 * It rejects when the host cannot be reached; a certificate failure rejects with a message that
 * contains `CERT_INVALID`.
 */
export interface HttpGetPort {
  get(url: string): Promise<HttpGetResult>;
}

export const HTTP_GET_TIMEOUT_MS = 10_000;
export const HTTP_GET_MAX_BYTES = 64 * 1024;

/** The plugin's JavaScript surface for `httpGet`, on `CapybaraHost`. */
export interface HttpGetNative {
  httpGet(options: { url: string }): Promise<HttpGetResult>;
}

export function httpGetPortFrom(native: HttpGetNative): HttpGetPort {
  return { get: (url) => native.httpGet({ url }) };
}

/** What the address page can refuse with. `sign_in_unavailable` has its own mobile copy. */
export type AddressErrorKind =
  | "invalid"
  | "insecure"
  | "unreachable"
  | "not_capybara"
  | "cert_invalid"
  | "too_old"
  | "sign_in_unavailable"
  | "locked";

/** A `fetch` over the port with `redirect: "error"` semantics: a 3xx rejects. */
function fetchOver(port: HttpGetPort): typeof fetch {
  return async (input) => {
    const res = await port.get(String(input));
    if (res.status >= 300 && res.status < 400) throw new TypeError("redirect");
    // An oversized body is never parsed: an unparseable stand-in makes it not_capybara.
    return new Response(res.truncated ? "truncated" : res.body, { status: res.status });
  };
}

export async function discover(
  input: string,
  deps: { httpGet: HttpGetPort },
): Promise<{ base: string; meta: Meta } | { error: AddressErrorKind }> {
  const address = normalizeAddress(input);
  if (!address.ok) return { error: address.reason };
  const meta = await fetchMeta(address.base, fetchOver(deps.httpGet));
  if ("error" in meta) return { error: meta.error };
  return { base: address.base, meta };
}

/** The managed configuration the start route sees (Task 18 reads it from the OS). */
export interface ManagedConfig {
  presetUrl?: string | null;
  lockToPreset?: boolean;
}

/**
 * The preset in force (Decision 8): a brand with `lockToPreset` wins; otherwise a valid managed
 * `presetUrl` / `lockToPreset` overrides the brand's. A bad managed field is ignored.
 */
export function effectivePreset(
  brand: Brand,
  managed: ManagedConfig | null,
): { base: string; locked: boolean } | null {
  const fromBrand = brand.presetUrl ? normalizeAddress(brand.presetUrl) : null;
  if (brand.lockToPreset && fromBrand?.ok) return { base: fromBrand.base, locked: true };
  const fromManaged =
    typeof managed?.presetUrl === "string" ? normalizeAddress(managed.presetUrl) : null;
  // Only https presets (the brand validator's rule too); the loopback http exception is for typing.
  const usable = (a: ReturnType<typeof normalizeAddress> | null) =>
    a?.ok === true && a.origin.startsWith("https:") ? a : null;
  const managedOk = usable(fromManaged);
  if (managedOk) {
    return { base: managedOk.base, locked: managed?.lockToPreset === true };
  }
  const brandOk = usable(fromBrand);
  return brandOk ? { base: brandOk.base, locked: false } : null;
}

/**
 * Where the app starts: a profile to open, or the address page. A preset with no profile is added
 * (discovery fills its name and icon later); a locked preset always opens its own profile.
 */
export async function startRoute(
  brand: Brand,
  managed: ManagedConfig | null,
  profiles: ProfileStore,
): Promise<"address" | { profileId: string }> {
  const preset = effectivePreset(brand, managed);
  if (preset?.locked) {
    const own =
      profiles.list().find((p) => p.base === preset.base) ??
      (await profiles.add({ base: preset.base, name: null, iconUrl: null }));
    return { profileId: own.id };
  }
  const current = profiles.current() ?? profiles.list()[0] ?? null;
  if (current) return { profileId: current.id };
  if (preset) {
    const added = await profiles.add({ base: preset.base, name: null, iconUrl: null });
    return { profileId: added.id };
  }
  return "address";
}
