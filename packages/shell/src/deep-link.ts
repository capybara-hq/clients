export type DeepLink =
  | { kind: "auth"; code?: string; error?: string; state: string; iss: string }
  | { kind: "connect"; address: string }
  | { kind: "open"; url: string };

export type AuthCallback = Extract<DeepLink, { kind: "auth" }>;

/**
 * Parses a link of the app's own scheme (the brand's `scheme`, e.g. `capybara`). It only parses:
 * the caller validates addresses and URLs.
 */
export function parseDeepLink(raw: string, scheme: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme.toLowerCase()}:`) return null;
  const q = url.searchParams;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  if (host === "auth" && path === "/callback") {
    const state = q.get("state");
    const iss = q.get("iss");
    const code = q.get("code");
    const error = q.get("error");
    if (!state || !iss || (!code && !error)) return null;
    // When both are present the error wins: never act on a code next to a denial.
    return { kind: "auth", state, iss, ...(error ? { error } : { code: code as string }) };
  }
  if (host === "connect" && path === "") {
    const address = q.get("url");
    return address ? { kind: "connect", address } : null;
  }
  if (host === "open" && path === "") {
    const target = q.get("url");
    return target ? { kind: "open", url: target } : null;
  }
  return null;
}
