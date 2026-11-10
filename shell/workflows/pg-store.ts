// The database-backed workflow store (the Store contract in core/workflows/store.ts), shared by the crons and the
// CRM shell, so a cron's queued approval is the row the shell's Approvals page shows. Plain SQL through pg on any
// Postgres. Runs under Node's own TypeScript support, so it imports nothing through path aliases.
//
// - "approvals" is one shared namespace (approval ids already carry the workflow id); every other namespace is
//   prefixed with the workflow's id, so two workflows that both keep a "seen" list never share it.
// - locked() is a lease in the "shell_Locks" table, not a session advisory lock: a session lock is lost when a
//   transaction pooler (Supabase :6543, PgBouncer transaction mode) hands the unlock to another server connection.
//   Each statement below stands alone, so it works through any pooler. The lease is claimed with one atomic insert
//   (or a take-over once the old lease has expired), renewed while the work runs, and released in finally. Every
//   clock reading is the database's own now(), so two machines with different clocks agree.
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Store } from "../../core/workflows/store.ts";
import { pgPoolConfig } from "../lib/db-ssl.ts";

const SAFE = /^[a-z0-9][a-z0-9:._-]{0,140}$/i;
const SHARED = new Set(["approvals", "approve-claims"]);
const RETRY_MS = 250;

export interface LockOptions {
  /** How long a lease lasts without renewal, in seconds. */
  leaseSeconds?: number;
  /** How often the holder renews its lease, in milliseconds. Must be well under the lease. */
  renewMs?: number;
  /** How long a waiter polls for a lease held by someone else before it gives up, in milliseconds. */
  waitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PgStore implements Store {
  private pool: pg.Pool;
  private scope: string;
  private lease: number;
  private renewMs: number;
  private waitMs: number;
  constructor(scope: string, pool?: pg.Pool, opts: LockOptions = {}) {
    if (!SAFE.test(scope)) throw new Error("bad store scope");
    this.scope = scope;
    this.pool = pool ?? new pg.Pool({ ...pgPoolConfig(process.env.DATABASE_URL ?? ""), max: 3 });
    this.lease = opts.leaseSeconds ?? 30;
    this.renewMs = opts.renewMs ?? 10_000;
    this.waitMs = opts.waitMs ?? 120_000;
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
  /**
   * Run fn while holding the lease for ns. Waits up to waitMs for a lease someone else holds; throws if it cannot get
   * one in time. The lease is released in finally, even when fn throws. If the lease ran out while fn was running
   * (the holder stalled for longer than the lease), another run may have taken it, so locked() throws after fn
   * instead of reporting success.
   */
  async locked<T>(ns: string, fn: () => T | Promise<T>): Promise<T> {
    const name = this.ns(ns);
    const owner = randomUUID();
    const deadline = Date.now() + this.waitMs;
    // Atomic claim: a new row, or a take-over of a row whose lease has run out. Nothing else can win the same row.
    for (;;) {
      const r = await this.pool.query(
        'INSERT INTO "shell_Locks" (name, owner, "expiresAt") VALUES ($1, $2, now() + make_interval(secs => $3)) ' +
          'ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, "expiresAt" = EXCLUDED."expiresAt" ' +
          'WHERE "shell_Locks"."expiresAt" <= now() RETURNING owner',
        [name, owner, this.lease],
      );
      if (r.rows[0]?.owner === owner) break;
      if (Date.now() >= deadline) throw new Error(`store ${ns} is busy: another run holds it`);
      await sleep(RETRY_MS);
    }
    let lost = false;
    const beat = setInterval(() => {
      this.pool
        .query('UPDATE "shell_Locks" SET "expiresAt" = now() + make_interval(secs => $3) WHERE name = $1 AND owner = $2 RETURNING owner', [name, owner, this.lease])
        .then((r) => { if (!r.rows.length) lost = true; })
        .catch(() => {}); // a missed renewal is retried on the next beat; the lease is lost only if it runs out
    }, this.renewMs);
    beat.unref();
    // Release: the row goes only if we still own it. Zero rows back means the lease was taken over.
    const release = async () => {
      clearInterval(beat);
      const r = await this.pool.query('DELETE FROM "shell_Locks" WHERE name = $1 AND owner = $2 RETURNING owner', [name, owner]);
      if (!r.rows.length) lost = true;
    };
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      await release().catch(() => {}); // the error from fn is the one that matters; an unreleased row expires on its own
      throw e;
    }
    await release();
    if (lost) throw new Error(`store ${ns}: the lease ran out during the run and another run may have taken it; check before retrying`);
    return out;
  }
  async end(): Promise<void> { await this.pool.end(); }
}
