// Bond lodgement workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { register, releaseCheck, CRONS } from "../industries/real-estate/workflows/finance-admin/bond-lodgement/index.ts";

const FOLDER = "industries/real-estate/workflows/finance-admin/bond-lodgement";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const BOX = "bonds@example.com.au", DRAFT = "AAMkDraft1";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

const TENANCIES = { totalPages: 1, items: [
  { property: { id: 1, displayAddress: "1 Test St" }, tenancy: { id: 101, start: "2026-01-01T00:00:00Z", end: "2026-10-31T00:00:00Z", bondReceipted: 2400, archived: false } },
  { property: { id: 2, displayAddress: "2 Test St" }, tenancy: { id: 102, start: "2026-09-01T00:00:00Z", end: "2027-08-31T00:00:00Z", bondReceipted: null, archived: false } },
  { property: { id: 3, displayAddress: "3 Test St" }, tenancy: { id: 103, start: "2025-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z", bondReceipted: 1800, archived: true } },
] };
const SET: any = { business_name: "Test Realty", notify: "team@example.com.au", microsoft_365: { mailbox: BOX },
  register: { drive: "DRIVE1", item: "ITEM1", table: "BondRegister" }, max_pages: 2 };

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.hostname.includes("vaultre")) return p.endsWith("/properties/residential/lease/tenancies") ? json(TENANCIES) : new Response("not faked: " + p, { status: 404 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: DRAFT });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const pending = async (store: MemoryStore) =>
  Object.values(await store.list<Approval>("approvals")).filter((a) => a.workflow === WF.id && a.status === "pending");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { VAULTRE_ACCESS_TOKEN: "v", VAULTRE_API_KEY: "k", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("the crons are wired by entry name", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["register", "release-check"]);
});

test("a live operation cannot be drafted and a draft cannot be queued", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "vaultre", op: "getResidentialLeaseTenancies", summary: "x" }), /not a live operation/);
});

test("register drafts one row per live tenancy, and re-runs never duplicate", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await register(ctx), { added: 2, flagged: 1 });
  const rows = hits.filter((h) => h.path.endsWith("/rows"));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].body.values[0][4], "NOT RECEIPTED");
  assert.deepEqual(await register(ctx), { added: 0, flagged: 0 });
  assert.equal(hits.filter((h) => h.path.endsWith("/rows")).length, 2);
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("release check queues a reminder for an ended, receipted bond and never sends", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await releaseCheck(ctx), { queued: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const p = await pending(store);
  assert.equal(p.length, 1);
  assert.equal(p[0].acts[0].op, "users.user.messages.message.send");
  assert.equal(p[0].acts[0].input?.params?.["message-id"], DRAFT);
});

test("re-runs never queue a reminder twice, and an approved reminder sends once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await releaseCheck(ctx); await releaseCheck(ctx);
  const p = await pending(store);
  assert.equal(p.length, 1, "re-runs never queue twice");
  const ap = await approve(WF, store, p[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  await assert.rejects(approve(WF, store, p[0].id, "owner"), /already done/);
});
