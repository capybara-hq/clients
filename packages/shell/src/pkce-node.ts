// Node-only PKCE for the desktop main process. Not in the package index: a WebView bundle must
// never reach `node:crypto`. Import it as `@capybara-hq/shell/pkce-node`.
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
