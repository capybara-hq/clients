import { createHash, randomBytes } from "node:crypto";

/** PKCE (RFC 7636) with S256. `bytes` is injectable for the Appendix B test vector. */
export function createPkce(bytes: () => Buffer = () => randomBytes(32)): {
  verifier: string;
  challenge: string;
} {
  const verifier = bytes().toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * PKCE (RFC 7636) with S256 on Web Crypto and `btoa`: no Node modules, so it runs in a WebView.
 * `random` is injectable for the Appendix B test vector.
 */
export async function createPkceWeb(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(random(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
