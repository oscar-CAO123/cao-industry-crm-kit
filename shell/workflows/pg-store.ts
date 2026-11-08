// The database-backed workflow store (the Store contract in core/workflows/store.ts), shared by the crons and the
// CRM shell, so a cron's queued approval is the row the shell's Approvals page shows. Plain SQL through pg on any
// Postgres. Runs under Node's own TypeScript support, so it imports nothing through path aliases.
//
// - "approvals" is one shared namespace (approval ids already carry the workflow id); every other namespace is
//   prefixed with the workflow's id, so two workflows that both keep a "seen" list never share it.
// - locked() holds a Postgres advisory lock for the namespace, so two runners on two machines cannot both claim
//   the same approval.
import pg from "pg";
import type { Store } from "../../core/workflows/store.ts";
import { pgPoolConfig } from "../lib/db-ssl.ts";

const SAFE = /^[a-z0-9][a-z0-9:._-]{0,140}$/i;
const SHARED = new Set(["approvals", "approve-claims"]);

export class PgStore implements Store {
  private pool: pg.Pool;
  private scope: string;
  constructor(scope: string, pool?: pg.Pool) {
    if (!SAFE.test(scope)) throw new Error("bad store scope");
    this.scope = scope;
    this.pool = pool ?? new pg.Pool({ ...pgPoolConfig(process.env.DATABASE_URL ?? ""), max: 3 });
  }
  private ns(ns: string, key?: string): string {
    if (!SAFE.test(ns) || (key !== undefined && !SAFE.test(key))) throw new Error(`bad store name: ${ns}${key ? "/" + key : ""}`);
    return SHARED.has(ns) ? ns : `${this.scope}:${ns}`;
  }
  async get<T>(ns: string, key: string): Promise<T | undefined> {
    const r = await this.pool.query('SELECT value FROM "shell_State" WHERE ns = $1 AND key = $2', [this.ns(ns, key), key]);
    return r.rows[0]?.value as T | undefined;
  }
  async put(ns: string, key: string, value: unknown): Promise<void> {
    await this.pool.query(
      'INSERT INTO "shell_State" (ns, key, value, "updatedAt") VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (ns, key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()',
      [this.ns(ns, key), key, JSON.stringify(value ?? null)],
    );
  }
  async list<T>(ns: string): Promise<Record<string, T>> {
    const r = await this.pool.query('SELECT key, value FROM "shell_State" WHERE ns = $1', [this.ns(ns)]);
    return Object.fromEntries(r.rows.map((x) => [x.key, x.value as T]));
  }
  async locked<T>(ns: string, fn: () => T | Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtext($1))", [this.ns(ns)]);
      try { return await fn(); } finally { await c.query("SELECT pg_advisory_unlock(hashtext($1))", [this.ns(ns)]); }
    } finally { c.release(); }
  }
  async end(): Promise<void> { await this.pool.end(); }
}
