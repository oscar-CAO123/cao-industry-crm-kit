#!/usr/bin/env node
// Apply the shell's database changes: every db/NNNN_name.sql file, in order, once each.
//
//   sh shell/scripts/with-secrets.sh -- node shell/scripts/db-apply.mjs            (applies)
//   node shell/scripts/db-apply.mjs --check                                            (checks the files, no database)
//
// Rules, enforced here (they are why prisma db push and prisma migrate are never used on a live database):
// - Files run in name order, each inside one transaction, and each is recorded in "shell_SchemaChanges" so it never
//   runs twice. A recorded file whose contents changed stops everything: a change is a new file, never an edit.
// - After the baseline (0001), a change may only ADD: no DROP, RENAME, TRUNCATE, DELETE, ALTER ... TYPE or
//   ALTER ... DROP. Removing or reshaping live data is a human decision made outside this tool.
// - The baseline only ever runs on an empty database.
// - Migrations connect with DIRECT_URL when it is set, because a pooler (Supabase :6543, PgBouncer transaction mode)
//   cannot run them. Without DIRECT_URL they use DATABASE_URL.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db");
const NAME = /^(\d{4})_[a-z0-9_-]+\.sql$/;
const FORBIDDEN = [/\bDROP\b/i, /\bRENAME\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bALTER\s+(TABLE|COLUMN)\b[^;]*\bTYPE\b/i, /\bALTER\b[^;]*\bDROP\b/i];

const strip = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
export function files(dir = DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => {
    if (!NAME.test(f)) throw new Error(`${f}: name must be NNNN_words.sql`);
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    return { name: f, n: Number(NAME.exec(f)[1]), sql, hash: crypto.createHash("sha256").update(sql).digest("hex") };
  });
}
export function check(list) {
  const seen = new Set();
  for (const f of list) {
    if (seen.has(f.n)) throw new Error(`two files numbered ${f.n}`);
    seen.add(f.n);
    if (f.n === 1) continue;
    for (const re of FORBIDDEN) if (re.test(strip(f.sql))) throw new Error(`${f.name}: only additive changes are allowed after the baseline (found ${re.source})`);
  }
  if (!list.length || list[0].n !== 1) throw new Error("the first file must be 0001, the baseline");
  return list;
}

/** The string migrations run on: DIRECT_URL when the host sets it, otherwise DATABASE_URL. */
export function migrationUrl(env = process.env) {
  return env.DIRECT_URL || env.DATABASE_URL || "";
}

async function apply(list) {
  const { default: pg } = await import("pg");
  const { pgPoolConfig } = await import("../lib/db-ssl.ts");
  const url = migrationUrl();
  if (!url) throw new Error("DATABASE_URL (or DIRECT_URL) is not set (it comes from 1Password through with-secrets.sh)");
  const pool = new pg.Pool({ ...pgPoolConfig(url), max: 1 });
  const c = await pool.connect();
  try {
    await c.query('CREATE TABLE IF NOT EXISTS "shell_SchemaChanges" (name text PRIMARY KEY, hash text NOT NULL, "appliedAt" timestamptz NOT NULL DEFAULT now())');
    const done = new Map((await c.query('SELECT name, hash FROM "shell_SchemaChanges"')).rows.map((r) => [r.name, r.hash]));
    for (const f of list) {
      if (done.has(f.name)) { if (done.get(f.name) !== f.hash) throw new Error(`${f.name} changed after it was applied; add a new file instead`); continue; }
      if (f.n === 1) {
        const t = await c.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'shell_SchemaChanges'");
        if (t.rows[0].n > 0) throw new Error("the baseline only runs on an empty database");
      }
      await c.query("BEGIN");
      try { await c.query(f.sql); await c.query('INSERT INTO "shell_SchemaChanges" (name, hash) VALUES ($1, $2)', [f.name, f.hash]); await c.query("COMMIT"); }
      catch (e) { await c.query("ROLLBACK"); throw new Error(`${f.name} failed and was rolled back: ${String(e.message).slice(0, 200)}`); }
      console.log(`applied ${f.name}`);
    }
    console.log("database is up to date");
  } finally { c.release(); await pool.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const list = check(files());
    if (process.argv.includes("--check")) console.log(`${list.length} schema files checked`);
    else await apply(list);
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
