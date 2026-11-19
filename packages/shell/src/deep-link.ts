export type DeepLink =
  | { kind: "auth"; code?: string; error?: string; state: string; iss: string }
  | { kind: "connect"; address: string }
  | { kind: "open"; url: string };

export type AuthCallback = Extract<DeepLink, { kind: "auth" }>;

/** Parses a `capybara:` link. It only parses: the caller validates addresses and URLs. */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "capybara:") return null;
  const q = url.searchParams;
  const path = url.pathname.replace(/\/+$/, "");
  if (url.hostname === "auth" && path === "/callback") {
    const state = q.get("state");
    const iss = q.get("iss");
    const code = q.get("code");
    const error = q.get("error");
    if (!state || !iss || (!code && !error)) return null;
    return {
      kind: "auth",
      state,
      iss,
      ...(code ? { code } : {}),
      ...(error ? { error } : {}),
    };
  }
  if (url.hostname === "connect" && path === "") {
    const address = q.get("url");
    return address ? { kind: "connect", address } : null;
  }
  if (url.hostname === "open" && path === "") {
    const target = q.get("url");
    return target ? { kind: "open", url: target } : null;
  }
  return null;
}
