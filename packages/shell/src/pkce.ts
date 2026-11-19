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
