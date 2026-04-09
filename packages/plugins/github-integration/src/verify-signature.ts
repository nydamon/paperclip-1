import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify GitHub webhook HMAC-SHA256 signature.
 *
 * @param rawBody  The raw request body string (must match what GitHub signed).
 * @param signature  The value of the `x-hub-signature-256` header (`sha256=<hex>`).
 * @param secret  The shared webhook secret.
 * @returns `true` if the signature is valid.
 */
export function verifyGitHubSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const [algo, hex] = signature.split("=", 2);
  if (algo !== "sha256" || !hex) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  if (expected.length !== hex.length) return false;

  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hex, "hex"));
}
