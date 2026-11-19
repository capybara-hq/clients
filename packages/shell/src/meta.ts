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
  if (typeof min !== "number" || typeof max !== "number") return null;
  if (!isRecord(features)) return null;
  if (typeof features.localDevices !== "boolean" || typeof features.appSignIn !== "boolean") {
    return null;
  }
  return {
    name,
    icon,
    protocols: { device: { min, max } },
    features: { localDevices: features.localDevices, appSignIn: features.appSignIn },
  };
}

/** Asks a deployment what it is. `base` comes from `normalizeAddress`. */
export async function fetchMeta(base: string, fetchFn: typeof fetch): Promise<Meta | MetaError> {
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/v1/meta`, { cache: "no-store" });
  } catch {
    return { error: "unreachable" };
  }
  if (!res.ok) return { error: "not_capybara" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { error: "not_capybara" };
  }
  const meta = parseMeta(body);
  if (meta === null) return { error: "not_capybara" };
  if (meta.features.appSignIn !== true) return { error: "too_old" };
  return meta;
}
