// The CRM shell's rules, checked in code. Each test names the rule it holds (shell/AGENTS.md). No keys, no network,
// no database: the database is a stand-in, and every call that could leave the machine is expected to be refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL = path.join(ROOT, "shell");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "generated", ".next"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const code = walk(SHELL).filter((f) => /\.(tsx?|mjs|js)$/.test(f) && !f.includes(`${path.sep}__tests__${path.sep}`) && !f.includes(`${path.sep}tests${path.sep}`));
const read = (f: string) => fs.readFileSync(f, "utf8");
const rel = (f: string) => path.relative(SHELL, f);

// ---- Rule 1: no key in plain text -------------------------------------------------------------------------------
const secrets = await import(path.join(SHELL, "scripts/with-secrets.mjs"));

test("launcher: refs must be op:// references in the one vault", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, ".tmp-shell-"));
  try {
    const f = path.join(dir, "refs.json");
    fs.writeFileSync(f, JSON.stringify({ DATABASE_URL: "op://Biz/db/url" }));
    assert.deepEqual(secrets.readRefs(f, "Biz"), { DATABASE_URL: "op://Biz/db/url" });
    assert.throws(() => secrets.readRefs(f, "Other"), /vault other than SHELL_VAULT/);
    assert.throws(() => secrets.readRefs(f, ""), /SHELL_VAULT/);
    fs.writeFileSync(f, JSON.stringify({ DATABASE_URL: "postgres://user:pass@host/db" }));
    assert.throws(() => secrets.readRefs(f, "Biz"), /not an op:\/\/ reference/);
    fs.writeFileSync(f, JSON.stringify({ "bad name": "op://Biz/a/b" }));
    assert.throws(() => secrets.readRefs(f, "Biz"), /bad key name/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("no key files, env files or filled refs file anywhere in the shell", () => {
  const bad = walk(SHELL).filter((f) => /(^|\/)(\.env(\..+)?|.*\.pem|.*\.key|secrets\.refs\.json)$/.test(rel(f)) && !rel(f).endsWith(".example"));
  assert.deepEqual(bad.map(rel), []);
  const refs = JSON.parse(read(path.join(SHELL, "secrets.refs.example.json")));
  for (const v of Object.values(refs)) assert.match(String(v), /^op:\/\/YOUR_VAULT\//);
});

test("every environment name the shell reads is declared: a key in the refs example, or a plain setting", () => {
  const keys = new Set(Object.keys(JSON.parse(read(path.join(SHELL, "secrets.refs.example.json")))));
  const settings = new Set(["NODE_ENV", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_APP_NAME", "BETTER_AUTH_URL", "AUTH_SIGNUP_DOMAINS", "KIT_ROOT",
    "KIT_SETTINGS", "KIT_SETTINGS_JSON", "KIT_ALLOW_WRITES", "FILES_PUBLIC_ORIGIN", "SHELL_VAULT", "SHELL_SECRET_REFS", "MINIO_ENDPOINT",
    "MINIO_BUCKET", "NEXT_PUBLIC_MINIO_ENDPOINT", "EMAIL_FROM", "ENABLE_TEST_OTP", "TEST_USER_EMAIL", "PORT", "HOSTNAME", "CI"]);
  const launcher = new Set(["OP_SERVICE_ACCOUNT_TOKEN", "SHELL_OP_TOKEN", "CRON_SECRET", "DATABASE_CA_CERT"]);
  const unknown = new Set<string>();
  for (const f of code) for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) if (!keys.has(m[1]) && !settings.has(m[1]) && !launcher.has(m[1])) unknown.add(`${m[1]} (${rel(f)})`);
  assert.deepEqual([...unknown], []);
  for (const k of keys) assert.ok(!settings.has(k), `${k} is both a key and a plain setting`);
});

test("the image starts every process through the launcher", () => {
  const d = read(path.join(SHELL, "Dockerfile"));
  assert.match(d, /ENTRYPOINT \["sh", "shell\/scripts\/with-secrets\.sh", "--"\]/);
  assert.doesNotMatch(d, /^ENV .*(TOKEN|SECRET|PASSWORD|KEY)=/m);
});

// ---- Rule 2: nothing live without the approval click --------------------------------------------------------------
class FakePool {
  rows = new Map<string, unknown>();
  leases = new Map<string, { owner: string; expiresAt: number }>();
  async query(sql: string, p: unknown[] = []) {
    const k = (ns: unknown, key: unknown) => `${ns}\u0000${key}`;
    if (sql.startsWith('SELECT value FROM "shell_State"')) { const v = this.rows.get(k(p[0], p[1])); return { rows: v === undefined ? [] : [{ value: structuredClone(v) }] }; }
    if (sql.startsWith('INSERT INTO "shell_State"')) { this.rows.set(k(p[0], p[1]), JSON.parse(String(p[2]))); return { rows: [] }; }
    if (sql.startsWith('SELECT key, value FROM "shell_State"')) return { rows: [...this.rows].filter(([x]) => x.startsWith(`${p[0]}\u0000`)).map(([x, value]) => ({ key: x.split("\u0000")[1], value })) };
    // the approval lease (shell/workflows/pg-store.ts): one statement each, clock from the fake
    const name = String(p[0]), owner = String(p[1]), now = Date.now();
    if (sql.startsWith('INSERT INTO "shell_Locks"')) {
      const cur = this.leases.get(name);
      if (cur && cur.expiresAt > now) return { rows: [] };
      this.leases.set(name, { owner, expiresAt: now + Number(p[2]) * 1000 });
      return { rows: [{ owner }] };
    }
    if (sql.startsWith('UPDATE "shell_Locks"')) {
      const cur = this.leases.get(name);
      if (!cur || cur.owner !== owner) return { rows: [] };
      cur.expiresAt = now + Number(p[2]) * 1000;
      return { rows: [{ owner }] };
    }
    if (sql.startsWith('DELETE FROM "shell_Locks"')) {
      const cur = this.leases.get(name);
      if (!cur || cur.owner !== owner) return { rows: [] };
      this.leases.delete(name);
      return { rows: [{ owner }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

test("shared store: approvals are one namespace, everything else is kept per workflow", async () => {
  const { PgStore } = await import(path.join(SHELL, "workflows/pg-store.ts"));
  const pool = new FakePool();
  const a = new PgStore("all:invoicing", pool), b = new PgStore("job-tracking", pool);
  await a.put("approvals", "x1", { id: "x1" });
  await a.put("seen", "j1", true);
  assert.deepEqual(await b.list("approvals"), { x1: { id: "x1" } });
  assert.deepEqual(await b.list("seen"), {});
  assert.equal(await a.get("seen", "j1"), true);
  await assert.rejects(a.put("../x", "k", 1), /bad store name/);
  const order: number[] = [];
  await Promise.all([a.locked("approve-claims", async () => { order.push(1); await new Promise((r) => setTimeout(r, 20)); order.push(2); }), b.locked("approve-claims", async () => { order.push(3); })]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("an approved live act without KIT_ALLOW_WRITES fails closed: nothing is sent, the approval says why", async () => {
  delete process.env.KIT_ALLOW_WRITES;
  const { PgStore } = await import(path.join(SHELL, "workflows/pg-store.ts"));
  const { approve } = await import(path.join(ROOT, "core/workflows/runtime.ts"));
  const wf = JSON.parse(read(path.join(ROOT, "industries/all/workflows/finance-admin/invoicing/workflow.json")));
  const store = new PgStore(wf.id, new FakePool());
  const act = { platform: "xero", op: wf.live_ops.xero[0], input: {}, summary: "email invoice 1" };
  await store.put("approvals", "ap1", { id: "ap1", workflow: wf.id, summary: "email invoice 1", acts: [act], status: "pending", created: new Date().toISOString() });
  const done = await approve(wf, store, "ap1", "tester@example.com");
  assert.equal(done.status, "failed");
  assert.deepEqual(done.results, []);
  assert.ok(done.error);
  const bogus = { ...act, op: wf.draft_ops.xero[0] };
  await store.put("approvals", "ap2", { id: "ap2", workflow: wf.id, summary: "a draft op dressed as live", acts: [bogus], status: "pending", created: new Date().toISOString() });
  await assert.rejects(approve(wf, store, "ap2", "x"), /not a live operation/);
});

// ---- Access control, outbound calls, schema --------------------------------------------------------------------
// getUser (actions/get-user.ts) throws without an active session, so it counts.
const AUTH = /\b(getSession|requireSession|requireRole|requireAdmin|requireOwnerOrAdmin|assertActionSession|getUser|getStaffUser)\b/;

test("every API route checks a session (sign-in, the 404 catch-all and the token-checked trigger excepted)", () => {
  const routes = code.filter((f) => /app\/api\/.*\/route\.ts$/.test(f));
  // test-otp answers 404 unless NODE_ENV is not production AND ENABLE_TEST_OTP=1 (checked below).
  const open = ["app/api/auth/[...all]/route.ts", "app/api/[...unknown]/route.ts", "app/api/workflows/run/route.ts", "app/api/auth/test-otp/route.ts"];
  const bad = routes.filter((f) => !open.includes(rel(f)) && !AUTH.test(read(f))).map(rel);
  assert.deepEqual(bad, []);
  assert.match(read(path.join(SHELL, "app/api/workflows/run/route.ts")), /timingSafeEqual/);
  assert.match(read(path.join(SHELL, "app/api/auth/test-otp/route.ts")), /NODE_ENV === "production" \|\| process\.env\.ENABLE_TEST_OTP !== "1"/);
});

test("every server action file checks a session", () => {
  const isServer = (src: string) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(src);
  const files = code.filter((f) => isServer(read(f)));
  assert.ok(files.length > 50, `found ${files.length} server action files`);
  const bad = files.filter((f) => !AUTH.test(read(f))).map(rel);
  assert.deepEqual(bad, []);
});

test("the web app makes no outside calls and never imports the SDK", () => {
  const web = code.filter((f) => /^(app|lib|actions|components|hooks)\//.test(rel(f)));
  const bad = web.filter((f) => /\bfetch\(\s*[`"']https?:\/\//.test(read(f)) || /core\/sdk|core\/lib\/http/.test(read(f))).map(rel);
  assert.deepEqual(bad, []);
});

test("every page response carries the security headers", () => {
  const p = read(path.join(SHELL, "proxy.ts"));
  for (const h of ["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Content-Security-Policy", "'strict-dynamic'", "frame-ancestors 'none'"]) assert.ok(p.includes(h), h);
});

test("schema changes after the baseline may only add", async () => {
  const db = await import(path.join(SHELL, "scripts/db-apply.mjs"));
  const base = { name: "0001_baseline.sql", n: 1, sql: "DROP TABLE x;", hash: "a" };
  const add = (sql: string) => [base, { name: "0002_x.sql", n: 2, sql, hash: "b" }];
  assert.doesNotThrow(() => db.check(add('ALTER TABLE "a" ADD COLUMN "b" text; CREATE INDEX i ON "a" ("b");')));
  for (const sql of ["DROP TABLE a;", 'ALTER TABLE a RENAME COLUMN b TO c;', "TRUNCATE a;", "DELETE FROM a;", 'ALTER TABLE a ALTER COLUMN b TYPE int;', "ALTER TABLE a DROP COLUMN b;"])
    assert.throws(() => db.check(add(sql)), /only additive/, sql);
  assert.doesNotThrow(() => db.check(add("-- DROP TABLE a; is only a comment\nCREATE TABLE b (id int);")));
  assert.doesNotThrow(() => db.check(db.files(path.join(SHELL, "db"))));
});

// ---- Templates and deploys ---------------------------------------------------------------------------------------
const DEPARTMENTS = ["sales", "marketing", "customer-service", "customer-success", "fulfilment", "finance-admin", "people", "compliance-safety", "owner"];

test("13 industry templates: known departments and views, built workflows only, never records", () => {
  const inds = fs.readdirSync(path.join(ROOT, "industries")).filter((i) => fs.existsSync(path.join(ROOT, "industries", i, "crm-shell", "template.json")));
  assert.equal(inds.length, 13);
  for (const i of inds) {
    const t = JSON.parse(read(path.join(ROOT, "industries", i, "crm-shell", "template.json")));
    assert.equal(t.industry, i);
    assert.ok(!("records" in t), `${i} adds records`);
    const slugs = new Set<string>();
    for (const p of t.pages) {
      assert.ok(DEPARTMENTS.includes(p.department), `${i}: ${p.department}`);
      assert.ok(!slugs.has(`${p.department}/${p.slug}`), `${i}: duplicate page ${p.slug}`);
      slugs.add(`${p.department}/${p.slug}`);
      for (const t2 of p.tabs) assert.ok(["board", "table", "calendar", "feed", "dashboard"].includes(t2.view), `${i}: ${t2.view}`);
    }
    for (const w of t.workflows) {
      const rec = JSON.parse(read(path.join(ROOT, w.dir, "workflow.json")));
      assert.equal(rec.id, w.id, `${i}: ${w.dir}`);
      assert.ok(DEPARTMENTS.includes(w.department), `${i}: ${w.department}`);
    }
  }
});

test("every deploy target renders for every industry, with key names and op:// placeholders only", async () => {
  const { TARGETS, jobs, keyNames, render } = await import(path.join(ROOT, "tools/shell-deploy.ts"));
  const inds = fs.readdirSync(path.join(ROOT, "industries")).filter((i) => fs.existsSync(path.join(ROOT, "industries", i, "crm-shell", "template.json")));
  for (const i of inds) {
    const js = jobs([i]), keys = keyNames([i]);
    assert.ok(js.length > 0, i);
    // Cloud job names (Google Cloud Run, Azure Container Apps) must be lowercase, even for a camelCase cron entry.
    for (const j of js) assert.match(j.slug, /^[a-z0-9-]+$/, `${i} ${j.slug}`);
    for (const t of TARGETS) {
      const files = render(t, js, keys);
      const refs = JSON.parse(files["secrets.refs.json.example"]);
      for (const v of Object.values(refs)) assert.match(String(v), /^op:\/\/YOUR_VAULT\//);
      for (const [f, body] of Object.entries(files)) {
        assert.doesNotMatch(String(body), /(sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}|postgres(ql)?:\/\/[^<\s]+:[^<\s]+@)/, `${t}/${f}`);
        if (/run\.ts run/.test(String(body))) assert.match(String(body), /with-secrets\.sh|run\.ts run/);
      }
    }
  }
});
