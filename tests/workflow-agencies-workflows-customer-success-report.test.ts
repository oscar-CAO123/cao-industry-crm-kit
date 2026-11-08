// Client report pack tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pull, draft } from "../industries/agencies/workflows/customer-success/report/index.ts";
import { periodOf, keyOf } from "../industries/agencies/workflows/customer-success/report/types.ts";
import fs from "node:fs";

const DIR = "industries/agencies/workflows/customer-success/report";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "ops@example.com";
const NOW = new Date("2026-11-09T00:00:00Z");           // last full month is October 2026
const KEY = keyOf("Example Dental:2026-10");
const S: any = {
  business_name: "Test Agency",
  clients: [{ name: "Example Dental", contact_name: "Jo", contact_email: "jo@example.com",
    supermetrics: { ds_id: "GAWA", ds_accounts: ["123456789"], fields: ["date", "sessions"] } }],
};

type Hit = { method: string; path: string; body: any; url: string };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, url: u.toString() });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      if (p.endsWith("/query/data/json")) return json({ meta: { request_id: "r1" }, data: [["date", "sessions"], ["2026-10-01", "<b>12</b>"], ["2026-10-02", "30"]] });
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") return json({ id: "d1" });
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: "m1" });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const hitsOf = (path: string, method = "POST") => hits.filter((h) => h.path === path && h.method === method);
const writes = () => hits.filter((h) => h.method !== "GET" && !/\/token$/.test(h.path));

beforeEach(async () => {
  fake();
  setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { SUPERMETRICS_API_KEY: "sm_test", GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("the month is the last full calendar month", () => {
  assert.deepEqual(periodOf(NOW), { key: "2026-10", start: "2026-10-01", end: "2026-10-31" });
});

test("pull reads the numbers and writes nothing to a platform", async () => {
  const store = new MemoryStore();
  const r = await pull(context(WF, S, store, NOW, () => {}));
  assert.equal(r.pulled, 1);
  assert.deepEqual(r.errors, []);
  const q = (await store.get<any>("pulls", KEY))!;
  assert.equal(q.rows[0][0], "date");
  assert.equal(hits.filter((h) => h.method === "GET" && h.path.endsWith("/query/data/json")).length, 1);
  assert.equal(writes().length, 0);
  assert.match(decodeURIComponent(new URL(hits[0].url).searchParams.get("json") ?? ""), /GAWA/);
});

test("draft waits for commentary and drafts nothing before it is written", async () => {
  const store = new MemoryStore();
  await pull(context(WF, S, store, NOW, () => {}));
  const r = await draft(context(WF, S, store, NOW, () => {}));
  assert.equal(r.drafted, 0);
  assert.equal(r.waiting_for_commentary, 1);
  assert.equal(hitsOf("/gmail/v1/users/me/drafts").length, 0);
});

test("draft creates the Gmail draft, queues the send, and never sends", async () => {
  const store = new MemoryStore();
  await pull(context(WF, S, store, NOW, () => {}));
  await store.put("commentary", KEY, { text: "Sessions rose in the second week.\n\nNext month we test a new landing page." });
  const r = await draft(context(WF, S, store, NOW, () => {}));
  assert.equal(r.drafted, 1);
  assert.equal(hitsOf("/gmail/v1/users/me/drafts").length, 1);
  assert.equal(hitsOf("/gmail/v1/users/me/drafts/send").length, 0);   // the cron never sends
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].acts[0].op, "gmail.users.drafts.send");
});

test("the report HTML escapes the numbers and the draft is addressed to the contact", async () => {
  const store = new MemoryStore();
  await pull(context(WF, S, store, NOW, () => {}));
  await store.put("commentary", KEY, { text: "Steady month." });
  await draft(context(WF, S, store, NOW, () => {}));
  const raw = Buffer.from(hitsOf("/gmail/v1/users/me/drafts")[0].body.message.raw, "base64url").toString("utf8");
  assert.match(raw, /To: jo@example\.com/);
  assert.match(raw, /Content-Type: text\/html/);
  const html = Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString("utf8");
  assert.ok(html.includes("&lt;b&gt;12&lt;/b&gt;"));
  assert.ok(!html.includes("<b>12</b>"));
});

test("running draft again never drafts or queues twice", async () => {
  const store = new MemoryStore();
  await pull(context(WF, S, store, NOW, () => {}));
  await store.put("commentary", KEY, { text: "Steady month." });
  await draft(context(WF, S, store, NOW, () => {}));
  const again = await draft(context(WF, S, store, NOW, () => {}));
  assert.equal(again.drafted, 0);
  assert.equal(hitsOf("/gmail/v1/users/me/drafts").length, 1);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("an approved send runs the Gmail draft send and nothing else", async () => {
  const store = new MemoryStore();
  await pull(context(WF, S, store, NOW, () => {}));
  await store.put("commentary", KEY, { text: "Steady month." });
  await draft(context(WF, S, store, NOW, () => {}));
  const [id] = Object.keys(await store.list("approvals"));
  const ap = await approve(WF, store, id, "tester", NOW);
  assert.equal(ap.status, "done");
  const sent = hitsOf("/gmail/v1/users/me/drafts/send");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { id: "d1" });
});

test("the runtime refuses a send as a draft and a read as a live operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "supermetrics", op: "getData", summary: "x" }), /not a live operation/);
});
