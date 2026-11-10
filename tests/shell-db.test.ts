// The shell's database rules, checked on a fake pg client. No database, no network: the fake keeps the approval lease
// table in memory and answers only the statements the shell sends. A connection is never handed out for the lock, so
// the fake refuses connect(): the lock has to work through a pooler, which hands each statement to any server connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PgStore } = await import(path.join(ROOT, "shell/workflows/pg-store.ts"));
const { pgPoolConfig } = await import(path.join(ROOT, "shell/lib/db-ssl.ts"));
const dbApply = await import(path.join(ROOT, "shell/scripts/db-apply.mjs"));

class LeaseDb {
  rows = new Map<string, { owner: string; expiresAt: number }>();
  connects = 0;
  async query(sql: string, p: unknown[] = []) {
    const name = String(p[0]), owner = String(p[1]), now = Date.now();
    if (sql.startsWith('INSERT INTO "shell_Locks"')) {
      const cur = this.rows.get(name);
      if (cur && cur.expiresAt > now) return { rows: [] };
      this.rows.set(name, { owner, expiresAt: now + Number(p[2]) * 1000 });
      return { rows: [{ owner }] };
    }
    if (sql.startsWith('UPDATE "shell_Locks"')) {
      const cur = this.rows.get(name);
      if (!cur || cur.owner !== owner) return { rows: [] };
      cur.expiresAt = now + Number(p[2]) * 1000;
      return { rows: [{ owner }] };
    }
    if (sql.startsWith('DELETE FROM "shell_Locks"')) {
      const cur = this.rows.get(name);
      if (!cur || cur.owner !== owner) return { rows: [] };
      this.rows.delete(name);
      return { rows: [{ owner }] };
    }
    throw new Error(`unexpected SQL in the lock test: ${sql}`);
  }
  async connect() { this.connects++; throw new Error("the lock must not hold a connection"); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fast = { leaseSeconds: 5, renewMs: 1_000, waitMs: 5_000 };

test("lock: one holder at a time, even when two runs share a pooled database", async () => {
  const db = new LeaseDb();
  const a = new PgStore("all:invoicing", db as any, fast);
  const b = new PgStore("job-tracking", db as any, fast);
  let inside = 0, peak = 0;
  const order: string[] = [];
  const job = (tag: string, store: any) => store.locked("approve-claims", async () => {
    inside++; peak = Math.max(peak, inside); order.push(`${tag} in`);
    await sleep(40);
    order.push(`${tag} out`); inside--;
    return tag;
  });
  const got = await Promise.all([job("a", a), job("b", b), job("c", a)]);
  assert.deepEqual(got, ["a", "b", "c"]);
  assert.equal(peak, 1, "two runs were inside the lock at once");
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].replace(" in", ""), order[i + 1].replace(" out", ""), order.join(" | "));
  assert.equal(db.connects, 0, "the lock took a connection and would not survive a transaction pooler");
  assert.equal(db.rows.size, 0, "the lease row is removed when the work finishes");
});

test("lock: a failed run releases the lease, so the next run is not blocked", async () => {
  const db = new LeaseDb();
  const a = new PgStore("x", db as any, fast);
  await assert.rejects(a.locked("approve-claims", () => { throw new Error("boom"); }), /boom/);
  assert.equal(db.rows.size, 0);
  assert.equal(await a.locked("approve-claims", () => "next"), "next");
});

test("lock: a live lease held by someone else makes the waiter give up with a busy error", async () => {
  const db = new LeaseDb();
  db.rows.set("approve-claims", { owner: "someone-else", expiresAt: Date.now() + 60_000 });
  const a = new PgStore("x", db as any, { ...fast, waitMs: 200 });
  let ran = false;
  await assert.rejects(a.locked("approve-claims", () => { ran = true; }), /is busy/);
  assert.equal(ran, false, "fn ran without the lease");
  assert.equal(db.rows.get("approve-claims")?.owner, "someone-else", "the waiter removed another run's lease");
});

test("lock: an expired lease is taken over at once", async () => {
  const db = new LeaseDb();
  db.rows.set("approve-claims", { owner: "crashed-run", expiresAt: Date.now() - 1 });
  const a = new PgStore("x", db as any, fast);
  assert.equal(await a.locked("approve-claims", () => "taken"), "taken");
  assert.equal(db.rows.size, 0);
});

test("lock: a stalled holder loses its lease, a waiter takes over, and the stalled run is told", async () => {
  const db = new LeaseDb();
  const stalled = new PgStore("x", db as any, { leaseSeconds: 0.2, renewMs: 60_000, waitMs: 3_000 });
  const waiter = new PgStore("y", db as any, { leaseSeconds: 5, renewMs: 1_000, waitMs: 3_000 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = stalled.locked("approve-claims", () => gate);
  await sleep(20);
  let waiterRan = false;
  await waiter.locked("approve-claims", () => { waiterRan = true; });
  assert.equal(waiterRan, true, "the waiter never got the expired lease");
  release();
  await assert.rejects(first, /lease ran out/);
});

test("lock: renewal keeps the lease for a run longer than one lease period", async () => {
  const db = new LeaseDb();
  const holder = new PgStore("x", db as any, { leaseSeconds: 0.3, renewMs: 50, waitMs: 5_000 });
  const rival = new PgStore("y", db as any, { leaseSeconds: 5, renewMs: 1_000, waitMs: 100 });
  const out = await holder.locked("approve-claims", async () => {
    await sleep(600);
    await assert.rejects(rival.locked("approve-claims", () => "stole it"), /is busy/);
    return "held";
  });
  assert.equal(out, "held");
});

test("migrations: DIRECT_URL is used when set, DATABASE_URL otherwise", () => {
  assert.equal(dbApply.migrationUrl({ DIRECT_URL: "postgres://direct.example.com/db", DATABASE_URL: "postgres://pool.example.com:6543/db" }), "postgres://direct.example.com/db");
  assert.equal(dbApply.migrationUrl({ DATABASE_URL: "postgres://only.example.com/db" }), "postgres://only.example.com/db");
  assert.equal(dbApply.migrationUrl({}), "");
});

test("prisma CLI: its datasource is DIRECT_URL when set, DATABASE_URL otherwise", async () => {
  const cfg = path.join(ROOT, "shell/prisma.config.ts");
  const saved = { D: process.env.DATABASE_URL, X: process.env.DIRECT_URL };
  try {
    process.env.DATABASE_URL = "postgres://pool.example.com:6543/db";
    process.env.DIRECT_URL = "postgres://direct.example.com:5432/db";
    const withDirect = (await import(`${pathToFileURL(cfg).href}?direct`)).default;
    assert.equal(withDirect.datasource.url, "postgres://direct.example.com:5432/db");
    delete process.env.DIRECT_URL;
    const without = (await import(`${pathToFileURL(cfg).href}?pooled`)).default;
    assert.equal(without.datasource.url, "postgres://pool.example.com:6543/db");
  } finally {
    if (saved.D === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.D;
    if (saved.X === undefined) delete process.env.DIRECT_URL; else process.env.DIRECT_URL = saved.X;
  }
});

test("ssl: a remote host is always encrypted and checked, whatever sslmode says", () => {
  for (const mode of ["", "?sslmode=require", "?sslmode=verify-full", "?sslmode=verify-ca", "?sslmode=no-verify", "?sslmode=prefer"]) {
    const c = pgPoolConfig(`postgresql://u:p@db.example.com:5432/app${mode}`, undefined);
    assert.deepEqual(c.ssl, { rejectUnauthorized: true, servername: "db.example.com" }, mode);
    assert.doesNotMatch(String(c.connectionString), /sslmode|ssl=|no-verify/, mode);
  }
});

test("ssl: the provider's CA bundle from DATABASE_CA_CERT is used when given", () => {
  const c = pgPoolConfig("postgresql://u:p@db.example.com/app?sslmode=verify-full", "PEM-TEXT");
  assert.deepEqual(c.ssl, { ca: "PEM-TEXT", rejectUnauthorized: true, servername: "db.example.com" });
});

test("ssl: sslmode=disable is honoured only on this machine or the compose network", () => {
  assert.equal(pgPoolConfig("postgresql://u:p@localhost:5432/app?sslmode=disable", undefined).ssl, false);
  assert.equal(pgPoolConfig("postgresql://u:p@db:5432/app?sslmode=disable", undefined).ssl, false);
  assert.throws(() => pgPoolConfig("postgresql://u:p@db.example.com:5432/app?sslmode=disable", undefined), (e: Error) => {
    assert.match(e.message, /sslmode=disable is refused/);
    assert.doesNotMatch(e.message, /u:p/);
    return true;
  });
});

test("ssl: a local database with no sslmode stays plain, and an explicit sslmode on it is honoured", () => {
  assert.equal(pgPoolConfig("postgresql://u:p@localhost:5432/app", undefined).ssl, false);
  assert.deepEqual(pgPoolConfig("postgresql://u:p@localhost:5432/app?sslmode=require", undefined).ssl, { rejectUnauthorized: true, servername: "localhost" });
});

test("ssl: a string that is not a URL passes through untouched", () => {
  assert.deepEqual(pgPoolConfig("not a url", undefined), { connectionString: "not a url" });
});
