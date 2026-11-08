// Workflow state: what each cron has seen, drafted and queued, and the approval queue the CRM shell shows.
// A store is a set of namespaces, each a map of key to JSON value. The file store suits a container or a server
// cron; a hosted deploy swaps in a database-backed store with the same three methods (the CRM shell provides one).

import fs from "node:fs";
import path from "node:path";

export interface Store {
  get<T = unknown>(ns: string, key: string): Promise<T | undefined>;
  put(ns: string, key: string, value: unknown): Promise<void>;
  list<T = unknown>(ns: string): Promise<Record<string, T>>;
  /** Run fn while holding an exclusive lock on ns. A database-backed store uses a row lock or advisory lock. */
  locked<T>(ns: string, fn: () => T | Promise<T>): Promise<T>;
}

const SAFE = /^[a-z0-9][a-z0-9:._-]{0,140}$/i;
function check(ns: string, key?: string): void {
  if (!SAFE.test(ns) || (key !== undefined && !SAFE.test(key))) throw new Error(`bad store name: ${ns}${key ? "/" + key : ""}`);
}

export class MemoryStore implements Store {
  private data = new Map<string, Map<string, unknown>>();
  private chains = new Map<string, Promise<unknown>>();
  async locked<T>(ns: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.chains.get(ns) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(ns, run.catch(() => {}));
    return run as Promise<T>;
  }
  async get<T>(ns: string, key: string) { check(ns, key); return structuredClone(this.data.get(ns)?.get(key)) as T | undefined; }
  async put(ns: string, key: string, value: unknown) {
    check(ns, key);
    if (!this.data.has(ns)) this.data.set(ns, new Map());
    this.data.get(ns)!.set(key, structuredClone(value));
  }
  async list<T>(ns: string) { check(ns); return Object.fromEntries([...(this.data.get(ns) ?? new Map()).entries()].map(([k, v]) => [k, structuredClone(v)])) as Record<string, T>; }
}

/** One JSON file per namespace under KIT_STATE_DIR (default ./state). Writes go to a temp file then rename. */
export class FileStore implements Store {
  private dir: string;
  constructor(dir = process.env.KIT_STATE_DIR ?? path.join(process.cwd(), "state")) { this.dir = dir; }
  private file(ns: string) { check(ns); return path.join(this.dir, `${ns}.json`); }
  private read(ns: string): Record<string, unknown> {
    try { return JSON.parse(fs.readFileSync(this.file(ns), "utf8")); } catch (e: any) { if (e.code === "ENOENT") return {}; throw e; }
  }
  async get<T>(ns: string, key: string) { check(ns, key); return this.read(ns)[key] as T | undefined; }
  async put(ns: string, key: string, value: unknown) {
    check(ns, key);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    await this.locked(ns, () => {
      const all = this.read(ns); all[key] = value;
      const tmp = `${this.file(ns)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.file(ns));
    });
  }
  /** Crons and approvals can overlap on one volume: each read-modify-write holds an exclusive lock file. */
  async locked<T>(ns: string, fn: () => T | Promise<T>): Promise<T> {
    const lock = `${this.file(ns)}.lock`;
    for (let i = 0; ; i++) {
      try { fs.closeSync(fs.openSync(lock, "wx", 0o600)); break; }
      catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) { fs.rmSync(lock, { force: true }); continue; } } catch {}
        if (i > 400) throw new Error(`store ${ns} is locked`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
  }
  async list<T>(ns: string) { return this.read(ns) as Record<string, T>; }
}
