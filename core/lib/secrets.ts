// Keys come from the environment, which the client's own secret store fills (1Password, Railway,
// a CI secret). Nothing here reads a file of keys or prints a value.
//
// Rotating tokens (Xero refresh tokens, Google OAuth refresh tokens) are kept in a token store
// outside the repo, so a commit can never carry one. The default store is a folder in the
// operator's home directory with owner-only permissions. The shell CRM swaps in its own store.

import fs from "node:fs";
import { randomBytes } from "node:crypto";
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
}

// Starts with a letter or digit and never holds "..", so a key name cannot leave the token folder.
const SAFE_KEY = /^[a-z0-9][a-z0-9._-]*$/i;

export class FileTokenStore implements TokenStore {
  dir: string;
  constructor(dir = process.env.KIT_TOKEN_DIR || path.join(os.homedir(), ".kit-tokens")) {
    this.dir = dir;
  }
  private file(key: string): string {
    if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error("bad token key");
    return path.join(this.dir, key);
  }
  async get(key: string): Promise<string | null> {
    try { return fs.readFileSync(this.file(key), "utf8").trim() || null; } catch { return null; }
  }
  async set(key: string, value: string): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(key);
    // A random name opened with O_EXCL and O_NOFOLLOW: a link planted in the token folder cannot redirect the write.
    const tmp = `${f}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, value); } finally { fs.closeSync(fd); }
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
