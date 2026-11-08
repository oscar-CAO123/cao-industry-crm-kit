// Portfolio reviews workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { reviewDue, prepare, invite, CRONS } from "../industries/financial-services/workflows/customer-success/x-portfolio/index.ts";
import { queueInvite, hsId, OP_INVITE, OP_LIST } from "../industries/financial-services/workflows/customer-success/x-portfolio/adapters/hubspot.ts";
import fs from "node:fs";

const DIR = "industries/financial-services/workflows/customer-success/x-portfolio";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const SLOT = { start: "2026-11-11T22:00:00Z", end: "2026-11-11T23:00:00Z" };
const SETTINGS: any = {
  business_name: "Example Advice", timezone: "Australia/Sydney",
  hubspot: { name_property: "name", due_property: "next_review_date", pack_properties: ["risk_profile", "objectives"], owner_id: "5001", organizer_user_id: "6001" },
};
const CLIENTS = [
  { id: "101", properties: { name: "Ada Park", next_review_date: "2026-11-01", risk_profile: "Balanced", objectives: "Retire at 60" } },
  { id: "102", properties: { name: "Ben Ko", next_review_date: String(Date.parse("2027-02-01")), risk_profile: "Growth", objectives: "Buy a home" } },
  { id: "../x", properties: { name: "Bad Row", next_review_date: "2026-11-01" } },
];

type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.search, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/crm/v3/objects/partner_clients" && m === "GET") return json({ results: CLIENTS });
      const one = p.match(/^\/crm\/v3\/objects\/partner_clients\/(\d+)$/);
      if (one && m === "GET") { const c = CLIENTS.find((x) => x.id === one[1]); return c ? json(c) : json({ status: "error" }, 404); }
      if (p === "/scheduler/v3/meetings/calendar" && m === "POST") return json({ id: "MTG-1" }, 201);
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { HUBSPOT_ACCESS_TOKEN: "hs-test-token", KIT_ALLOW_WRITES: "1" });
});

test("crons read and draft only: the invite is queued, and nothing reaches a client before approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await reviewDue(ctx), { due: 1 });
  assert.equal((await store.get<any>("reviews", "101")).status, "due");
  assert.equal((await store.get<any>("reviews", "102")).status, "not-due");
  assert.equal(Object.values(await store.list<any>("reviews")).length, 2, "the non-numeric id row is skipped");
  assert.deepEqual(await prepare(ctx), { prepared: 1 });
  assert.equal((await store.get<any>("packs", "101")).properties.objectives, "Retire at 60");
  await store.put("slots", "101", SLOT);
  assert.deepEqual(await invite(ctx), { queued: 1, waiting_for_slot: 0, refused: 0 });
  assert.equal(hits.filter((h) => h.path === "/scheduler/v3/meetings/calendar").length, 0, "no invite sent by a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
});

test("a live operation cannot run as a draft, and a read cannot be queued", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "hubspot", op: OP_INVITE, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "hubspot", op: OP_LIST, summary: "x" }), /not a live operation/);
});

test("the approved invite is created once; re-runs never queue it twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await reviewDue(ctx); await prepare(ctx);
  await store.put("slots", "101", SLOT);
  await invite(ctx);
  await invite(ctx);
  await reviewDue(ctx); await prepare(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "one approval after repeated runs");
  const done = await approve(WF, store, ap.id, "adviser", NOW);
  assert.equal(done.status, "done");
  const call = hits.find((h) => h.path === "/scheduler/v3/meetings/calendar")!;
  assert.equal(call.method, "POST");
  assert.match(call.query, /organizerUserId=6001/);
  assert.equal(call.body.timezone, "Australia/Sydney");
  assert.equal(call.body.properties.hs_meeting_title, "Portfolio review: Ada Park");
  assert.equal(call.body.properties.hs_meeting_start_time, new Date(SLOT.start).toISOString());
  assert.equal(call.body.properties.hubspot_owner_id, "5001");
  await assert.rejects(approve(WF, store, ap.id, "adviser", NOW), /already done/);
});

test("bad ids and time ranges are refused before any call", async () => {
  assert.throws(() => hsId("../x"), /bad id/);
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  assert.throws(() => queueInvite(ctx, { id: "101", name: "Ada Park" }, { start: SLOT.end, end: SLOT.start }), /end after it starts/);
  assert.equal(hits.length, 0);
});

test("the cron map matches the workflow record", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});
