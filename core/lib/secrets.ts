// Keys come from the environment, which the client's own secret store fills (1Password, Railway,
// a CI secret). Nothing here reads a file of keys or prints a value.
//
// Rotating tokens (Xero refresh tokens, Google OAuth refresh tokens) are kept in a token store
// outside the repo, so a commit can never carry one. The default store is a folder in the
// operator's home directory with owner-only permissions, and every file in it is encrypted
// (AES-256-GCM) with KIT_TOKEN_KEY, a random value of 32 or more characters kept in the business's
// 1Password vault and passed in like any other key. Without KIT_TOKEN_KEY no token is read or written.

import fs from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

export class MissingSecret extends Error {
  constructor(name: string) {
    super(`${name} is not set. Add it to the client's secret store and pass it into this run.`);
    this.name = "MissingSecret";
  }
}

export function secret(name: string): string {
  const v = process.env[name];
  if (!v) throw new MissingSecret(name);
  return v;
}

export function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export interface TokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Throws if a new token could not be saved. Called BEFORE a single-use refresh token is spent. */
  ready?(): void;
}

// Starts with a letter or digit and never holds "..", so a key name cannot leave the token folder.
const SAFE_KEY = /^[a-z0-9][a-z0-9._-]*$/i;

function tokenKey(): Buffer {
  const k = process.env.KIT_TOKEN_KEY ?? "";
  if (k.length < 32) throw new MissingSecret("KIT_TOKEN_KEY (32 or more random characters)");
  return createHash("sha256").update(k).digest();
}
// File format: v1.<iv>.<tag>.<ciphertext>, each base64url. The token name is bound in as associated data, so a
// file copied over another token's name does not decrypt.
function seal(name: string, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", tokenKey(), iv);
  c.setAAD(Buffer.from(name));
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(".");
}
function open(name: string, text: string): string | null {
  const m = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]*)$/.exec(text.trim());
  if (!m) {   // not a sealed token (a plain-text file is never trusted): the caller signs in again
    if (text.trim()) console.error(`[tokens] ${name} is not an encrypted token and was ignored: connect that app again`);
    return null;
  }
  const d = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(m[1], "base64url"));
  d.setAAD(Buffer.from(name));
  d.setAuthTag(Buffer.from(m[2], "base64url"));
  try { return Buffer.concat([d.update(Buffer.from(m[3], "base64url")), d.final()]).toString("utf8") || null; }
  catch { throw new Error(`token ${name} does not decrypt with this KIT_TOKEN_KEY`); }
}

export class FileTokenStore implements TokenStore {
  dir: string;
  constructor(dir = process.env.KIT_TOKEN_DIR || path.join(os.homedir(), ".kit-tokens")) {
    this.dir = dir;
  }
  private file(key: string): string {
    if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error("bad token key");
    return path.join(this.dir, key);
  }
  ready(): void { tokenKey(); }
  async get(key: string): Promise<string | null> {
    const f = this.file(key);
    let text: string;
    try { text = fs.readFileSync(f, "utf8"); } catch { return null; }
    return open(key, text);
  }
  async set(key: string, value: string): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(key);
    const sealed = seal(key, value); // first: a missing KIT_TOKEN_KEY fails before any file is created
    // A random name opened with O_EXCL and O_NOFOLLOW: a link planted in the token folder cannot redirect the write.
    const tmp = `${f}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, sealed); } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
    fs.closeSync(fd);
    fs.renameSync(tmp, f);
  }
}

export class MemoryTokenStore implements TokenStore {
  values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
}

let store: TokenStore | null = null;
export function tokenStore(): TokenStore { return (store ??= new FileTokenStore()); }
export function setTokenStore(s: TokenStore | null): void { store = s; }
