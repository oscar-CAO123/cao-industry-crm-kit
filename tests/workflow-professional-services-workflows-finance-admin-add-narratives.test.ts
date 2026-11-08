// Billing narratives workflow tests. Every request goes to a fake network: no test reaches a real Xero organisation.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { capture, draft, refresh } from "../industries/professional-services/workflows/finance-admin/add-narratives/index.ts";
import { main } from "../tools/workflow.ts";

const DIR = "industries/professional-services/workflows/finance-admin/add-narratives";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const PROJ = "aaaaaaaa-1111-4222-8333-444444444444", CONTACT = "bbbbbbbb-1111-4222-8333-555555555555";
const T1 = "cccccccc-1111-4222-8333-666666666666", T2 = "dddddddd-1111-4222-8333-777777777777";
const E1 = "11111111-aaaa-4bbb-8ccc-000000000001", E2 = "11111111-aaaa-4bbb-8ccc-000000000002", E3 = "11111111-aaaa-4bbb-8ccc-000000000003";
const INV = "22222222-aaaa-4bbb-8ccc-000000000009";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let invoiceStatus = "DRAFT";
let createFails = false;

const FEED = [
  { timeEntryId: E1, userId: "u1", projectId: PROJ, taskId: T1, dateUtc: "2026-11-05T00:00:00", duration: 90, description: "Reviewed the Q3 accounts and sent queries", status: "ACTIVE" },
  { timeEntryId: E2, userId: "u1", projectId: PROJ, taskId: T1, dateUtc: "2026-11-06T00:00:00", duration: 30, description: "Phone call with the bank about the facility", status: "ACTIVE" },
  { timeEntryId: E3, userId: "u1", projectId: PROJ, taskId: T2, dateUtc: "2026-11-06T00:00:00", duration: 60, description: "Drafted the BAS working papers", status: "ACTIVE" },
];

function fake() {
  hits = []; invoiceStatus = "DRAFT"; createFails = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith(`/Projects/${PROJ}/Time`) && m === "GET") return json({ pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: FEED.length }, items: FEED });
      if (p.endsWith(`/Projects/${PROJ}/Tasks`)) return json({ pagination: {}, items: [
        { taskId: T1, name: "Advisory", rate: { currency: "AUD", value: 150 } }, { taskId: T2, name: "Compliance", rate: { currency: "AUD", value: 200 } }] });
      if (p.endsWith(`/Projects/${PROJ}`) && m === "GET") return json({ projectId: PROJ, contactId: CONTACT, name: "Harbour Dental" });
      if (p.endsWith("/Invoices") && m === "PUT") return createFails ? new Response("{}", { status: 500 }) : json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT" }] });
      if (p.endsWith(`/Invoices/${INV}`) && m === "POST") return json({ Invoices: [{ InvoiceID: INV, Status: "AUTHORISED" }] });
      if (p.endsWith(`/Invoices/${INV}`) && m === "GET") return json({ Invoices: [{ InvoiceID: INV, Status: invoiceStatus }] });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const SET: any = { business_name: "Test Accounting", projects: [PROJ], lookback_days: 31, payment_terms_days: 14 };
const PROPOSAL = { at: NOW.toISOString(), lines: [
  { narrative: "Review of the Q3 accounts, the bank facility and the client queries.", entry_ids: [E1, E2] },
  { narrative: "Preparation of the BAS working papers.", entry_ids: [E3] }] };
const pending = async (store: MemoryStore) => (await main(["approvals", DIR], store)) as any[];
const writes = () => hits.filter((h) => h.method !== "GET" && !/token$/.test(h.path)); // the OAuth refresh is not a Xero write

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a live operation/);
});

test("capture reads chargeable ACTIVE entries once and never stores one twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await capture(ctx), { read: 3, added: 3, gone: 0 });
  const q = hits.find((h) => h.path.endsWith(`/Projects/${PROJ}/Time`))!.query;
  assert.equal(q.get("states"), "ACTIVE");
  assert.equal(q.get("isChargeable"), "true");
  assert.deepEqual(await capture(ctx), { read: 3, added: 0, gone: 0 });
  assert.equal(Object.keys(await store.list("entries")).length, 3);
  assert.equal(writes().length, 0, "capture writes nothing to Xero");
});

test("no narrative proposal parks the client: no invoice and nothing queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, parked: 1 });
  assert.equal(writes().length, 0);
  assert.equal((await pending(store)).length, 0);
  assert.match((await store.get<any>("parked", PROJ))!.reason, /no narrative proposal/);
});

test("a proposal that misses an entry parks the client", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  await store.put("proposals", PROJ, { at: NOW.toISOString(), lines: [{ narrative: "Review of the Q3 accounts.", entry_ids: [E1] }] });
  assert.deepEqual(await draft(ctx), { drafted: 0, parked: 1 });
  assert.equal(writes().length, 0);
  assert.match((await store.get<any>("parked", PROJ))!.reason, /not covered/);
});

test("a covered proposal drafts one invoice, queues its authorisation, and never repeats", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  await store.put("proposals", PROJ, PROPOSAL);
  assert.deepEqual(await draft(ctx), { drafted: 1, parked: 0 });
  const put = hits.find((h) => h.method === "PUT" && h.path.endsWith("/Invoices"))!;
  const inv = put.body.Invoices[0];
  assert.equal(inv.Status, "DRAFT");
  assert.equal(inv.Contact.ContactID, CONTACT);
  assert.deepEqual(inv.LineItems.map((l: any) => [l.Description, l.Quantity, l.UnitAmount]), [
    ["Review of the Q3 accounts, the bank facility and the client queries.", 2, 150],
    ["Preparation of the BAS working papers.", 1, 200]]);
  assert.equal(writes().filter((h) => h.path.endsWith(`/Invoices/${INV}`)).length, 0, "nothing authorised before approval");
  assert.equal((await pending(store)).length, 1);
  assert.equal((await store.list<any>("entries"))[E1].status, "drafted");
  assert.deepEqual(await draft(ctx), { drafted: 0, parked: 0 });
  assert.equal(writes().filter((h) => h.method === "PUT").length, 1, "a re-run never creates a second invoice");
  assert.equal((await pending(store)).length, 1, "a re-run never queues twice");
});

test("approval authorises the draft invoice in Xero, and refresh records it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  await store.put("proposals", PROJ, PROPOSAL);
  await draft(ctx);
  const [ap] = await pending(store);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const post = writes().find((h) => h.method === "POST" && h.path.endsWith(`/Invoices/${INV}`))!;
  assert.deepEqual(post.body, { Invoices: [{ InvoiceID: INV, Status: "AUTHORISED" }] });
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
  invoiceStatus = "AUTHORISED";
  assert.deepEqual(await refresh(ctx), { checked: 1, changed: 1 });
  assert.equal((await store.get<any>("invoices", INV))!.status, "authorised");
});

test("a voided draft returns its entries to new so they can be drafted again", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  await store.put("proposals", PROJ, PROPOSAL);
  await draft(ctx);
  invoiceStatus = "VOIDED";
  assert.deepEqual(await refresh(ctx), { checked: 1, changed: 1 });
  assert.equal((await store.get<any>("invoices", INV))!.status, "voided");
  assert.equal((await store.get<any>("entries", E1))!.status, "new");
});

test("an entry that leaves ACTIVE in Xero is marked gone and is not drafted", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  FEED.splice(2, 1);
  try {
    assert.deepEqual(await capture(ctx), { read: 2, added: 0, gone: 1 });
  } finally {
    FEED.push({ timeEntryId: E3, userId: "u1", projectId: PROJ, taskId: T2, dateUtc: "2026-11-06T00:00:00", duration: 60, description: "Drafted the BAS working papers", status: "ACTIVE" });
  }
  assert.equal((await store.get<any>("entries", E3))!.status, "gone");
});

test("no email and no delete is ever sent to Xero in the whole flow", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  await store.put("proposals", PROJ, PROPOSAL);
  await draft(ctx);
  await approve(WF, store, (await pending(store))[0].id, "owner", NOW);
  assert.equal(hits.filter((h) => h.method === "DELETE" || /email|send/i.test(h.path)).length, 0);
});

test("with KIT_ALLOW_WRITES off the draft invoice is blocked before any socket opens", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  await store.put("proposals", PROJ, PROPOSAL);
  await assert.rejects(draft(ctx), WriteBlocked);
  assert.equal(writes().length, 0);
});
