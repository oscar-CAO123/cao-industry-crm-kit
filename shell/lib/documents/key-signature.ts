import { createHmac, timingSafeEqual } from "node:crypto";

// The upload route signs each key it issues together with the user it issued it to. A document may be created only with a key
// and signature the same user received, so nobody can attach a file they did not upload (an avatar, an invoice PDF) to a document
// row and then delete it. Stateless: it needs no table, only the server's own secret.
function secret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("BETTER_AUTH_SECRET is not set");
  return s;
}

export function signKey(key: string, userId: string): string {
  return createHmac("sha256", secret()).update(`upload-key\n${userId}\n${key}`).digest("base64url");
}

export function verifyKey(key: string, userId: string, sig: unknown): boolean {
  if (typeof sig !== "string" || sig.length > 100) return false;
  const want = Buffer.from(signKey(key, userId)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
