/** The shape of `GET /api/v1/meta`. A relative `icon` stays as returned: resolve it against the base. */
export interface Meta {
  name: string | null;
  icon: string | null;
  protocols: { device: { min: number; max: number } };
  features: { localDevices: boolean; appSignIn: boolean };
}

export type MetaError = { error: "unreachable" | "not_capybara" | "too_old" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseMeta(v: unknown): Meta | null {
  if (!isRecord(v)) return null;
  const { name, icon, protocols, features } = v;
  if (name !== null && typeof name !== "string") return null;
  if (icon !== null && typeof icon !== "string") return null;
  if (!isRecord(protocols) || !isRecord(protocols.device)) return null;
  const { min, max } = protocols.device;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (!isRecord(features)) return null;
  if (typeof features.localDevices !== "boolean" || typeof features.appSignIn !== "boolean") {
    return null;
  }
  return {
    name,
    icon,
    protocols: { device: { min: min as number, max: max as number } },
    features: { localDevices: features.localDevices, appSignIn: features.appSignIn },
  };
}

export const META_TIMEOUT_MS = 10_000;
export const META_MAX_BYTES = 64 * 1024;

/** Reads a body as text; null when it is larger than `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Asks a deployment what it is. `base` comes from `normalizeAddress`. A stalled server (10 s,
 * or the caller's `signal`), a network error and a redirect (never followed: another host
 * must not answer) are `unreachable`; an oversized body is `not_capybara`.
 */
export async function fetchMeta(
  base: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Meta | MetaError> {
  const timeout = AbortSignal.timeout(META_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetchFn(`${base}/api/v1/meta`, {
      cache: "no-store",
      redirect: "error",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) return { error: "not_capybara" };
    const text = await readCapped(res, META_MAX_BYTES);
    if (text === null) return { error: "not_capybara" };
    try {
      body = JSON.parse(text);
    } catch {
      return { error: "not_capybara" };
    }
  } catch {
    return { error: "unreachable" };
  }
  const meta = parseMeta(body);
  if (meta === null) return { error: "not_capybara" };
  if (meta.features.appSignIn !== true) return { error: "too_old" };
  return meta;
}
