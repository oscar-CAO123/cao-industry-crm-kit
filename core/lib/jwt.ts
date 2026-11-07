// RS256 JSON web tokens, for the service-account logins Google and DocuSign use.
import crypto from "node:crypto";

const b64url = (data: string | Buffer): string =>
  (typeof data === "string" ? Buffer.from(data) : data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function signJwt(claims: Record<string, unknown>, privateKeyPem: string): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

/** A PEM pasted into an env var often has literal \n in place of line breaks. */
export function pem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

/** A JSON key file may be stored raw or base64 encoded. */
export function jsonKey<T>(value: string): T {
  return JSON.parse(/^\s*\{/.test(value) ? value : Buffer.from(value, "base64").toString("utf8")) as T;
}
