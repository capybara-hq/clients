// Discovery for the address page and the start route (spec §4.1, §4.2).
//
// The page asks `GET <base>/api/v1/meta` through the native `HttpGet` (ShellPlugin), never through
// the WebView's own fetch: native refuses redirects, caps the wait and the body, and keeps its own
// cookie jar. `fetchMeta` and `normalizeAddress` come from the shell package; this file only
// adapts the native port to the `fetch` shape `fetchMeta` takes.
import { fetchMeta, type Meta, normalizeAddress } from "@capybara-hq/shell";
import type { Brand } from "../../brand.ts";
import { effectivePreset, enforcePolicy, type ManagedValues } from "./managed.ts";
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

const NULL_BODY = new Set([204, 205, 304]);

/**
 * A `fetch` over the port with `redirect: "error"` semantics: a 3xx rejects. The request's signal
 * (`fetchMeta`'s 10 s deadline, the caller's) rejects with an AbortError whatever the native side
 * is doing, so a slow-drip server cannot hold discovery open.
 */
function fetchOver(port: HttpGetPort): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal;
    signal?.throwIfAborted();
    const answer = port.get(String(input));
    const res = await (signal
      ? Promise.race([
          answer,
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        ])
      : answer);
    if (res.status >= 300 && res.status < 400 && res.status !== 304)
      throw new TypeError("redirect");
    // `Response` refuses a status outside 200..599 and a body on a null-body status: both are
    // simply not a deployment's meta, so they get a stand-in that reads as not_capybara.
    if (res.status < 200 || res.status > 599) return new Response(null, { status: 502 });
    if (NULL_BODY.has(res.status)) return new Response(null, { status: res.status });
    // An oversized body is never parsed: an unparseable stand-in makes it not_capybara.
    return new Response(res.truncated ? "truncated" : res.body, { status: res.status });
  };
}

export async function discover(
  input: string,
  deps: { httpGet: HttpGetPort; signal?: AbortSignal },
): Promise<{ base: string; meta: Meta } | { error: AddressErrorKind }> {
  const address = normalizeAddress(input);
  if (!address.ok) return { error: address.reason };
  const meta = await fetchMeta(address.base, fetchOver(deps.httpGet), deps.signal);
  if ("error" in meta) return { error: meta.error };
  return { base: address.base, meta };
}

/**
 * Where the app starts: a profile to open, or the address page. A locked preset (brand or managed,
 * `effectivePreset`) always opens its own profile, made current (`enforcePolicy`); otherwise the
 * current profile; else an unlocked preset is added (discovery fills its name and icon later).
 */
export async function startRoute(
  brand: Pick<Brand, "presetUrl" | "lockToPreset">,
  managed: ManagedValues | null,
  profiles: ProfileStore,
): Promise<"address" | { profileId: string }> {
  const policy = effectivePreset(brand, managed);
  const locked = await enforcePolicy(policy, profiles);
  if (locked) return { profileId: locked.profile.id };
  const current = profiles.current() ?? profiles.list()[0] ?? null;
  if (current) return { profileId: current.id };
  if (policy.presetUrl !== null) {
    const added = await profiles.add({ base: policy.presetUrl, name: null, iconUrl: null });
    return { profileId: added.id };
  }
  return "address";
}
