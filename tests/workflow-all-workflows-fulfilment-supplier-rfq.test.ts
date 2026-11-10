// Supplier RFQ workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/all/workflows/fulfilment/supplier-rfq/index.ts";
import fs from "node:fs";

const FOLDER = "industries/all/workflows/fulfilment/supplier-rfq";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const PO = "7d1e2f3a-1111-4222-8333-444455556666";
const CONTACT = "9a8b7c6d-aaaa-4bbb-8ccc-ddddeeeeffff";
const ARI = "ari@supplier.example", SAM = "sam@supplier.example";
const NOW = new Date("2026-11-09T00:00:00Z");
const SETTINGS: any = {
  business_name: "Test Fabrication",
  microsoft_365: { mailbox: "buyer@example.com", rfq_folder: "inbox", reply_search: "RFQ",
                   register: { drive: "DRIVE1", item: "ITEM1", table: "RFQRegister" } },
  chase_after_days: [3, 7],
};

type Hit = { method: string; path: string; body: any; headers?: any };
let hits: Hit[] = [];
let replyList: any[] = [];
let drafts = 0;

function fake() {
  hits = []; replyList = []; drafts = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, headers: init?.headers });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Microsoft Graph
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") { drafts++; return json({ id: `AAMkDraft${drafts}` }); }
      if (p.endsWith("/mailFolders/inbox/messages")) return json({ value: replyList });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      // Xero
      if (p.endsWith("/PurchaseOrders") && m === "PUT") return json({ PurchaseOrders: [{ PurchaseOrderID: PO, Status: "DRAFT" }] });
      if (p.endsWith(`/PurchaseOrders/${PO}`) && m === "POST") return json({ PurchaseOrders: [{ PurchaseOrderID: PO, Status: "AUTHORISED" }] });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

const rfq = (over: Record<string, unknown> = {}) => ({
  id: "rfq-001", title: "Precast panels, Lot 4", needed_by: "2026-11-20", status: "new",
  lines: [{ item: "Precast panel 3.0 m", qty: 12, unit: "ea", spec: "Grade 40" }],
  suppliers: [{ name: "Ari Shah", email: ARI }, { name: "Sam Lee", email: SAM }], ...over,
});
const run = (cron: string, store: MemoryStore, now = NOW) => CRONS[cron](context(WF, SETTINGS, store, now, () => {}));
const approvals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));
const sends = () => hits.filter((h) => /\/send$/.test(h.path));

test("runtime: a cron cannot run a live op and cannot queue a draft op", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updatePurchaseOrder", summary: "x" }), /not a draft operation/);
});

test("issue: drafts one RFQ per supplier, queues every send, sends nothing, and a re-run adds nothing", async () => {
  const store = new MemoryStore();
  await store.put("rfqs", "rfq-001", rfq());
  await run("issue", store);
  assert.equal(sends().length, 0, "a cron must never send");
  const aps = await approvals(store);
  assert.equal(aps.length, 2);
  assert.ok(aps.every((a) => a.status === "pending" && a.acts[0].op === "users.user.messages.message.send"));
  const created = hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));
  assert.equal(created.length, 2);
  assert.match(created[0].body.subject, /^RFQ rfq-001: /);
  const stored = await store.get<any>("rfqs", "rfq-001");
  assert.equal(stored.status, "issued");
  assert.deepEqual([...stored.sent].sort(), [ARI, SAM].sort());

  hits = [];
  await run("issue", store);
  assert.equal(hits.length, 0, "an issued RFQ is not touched again");
  assert.equal((await approvals(store)).length, 2);
});

test("approval sends each RFQ once and a second approval is refused", async () => {
  const store = new MemoryStore();
  await store.put("rfqs", "rfq-001", rfq());
  await run("issue", store);
  for (const a of await approvals(store)) await approve(WF, store, a.id, "oscar", NOW);
  assert.equal(sends().length, 2);
  assert.ok((await approvals(store)).every((a) => a.status === "done"));
  await assert.rejects(approve(WF, store, (await approvals(store))[0].id, "oscar", NOW), /already done/);
  assert.equal(sends().length, 2);
});

test("issue: a supplier with a bad email is never drafted", async () => {
  const store = new MemoryStore();
  await store.put("rfqs", "rfq-001", rfq({ suppliers: [{ name: "Bad", email: "not-an-email" }, { name: "Ari Shah", email: ARI }] }));
  await run("issue", store);
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages")).length, 1);
  assert.equal((await approvals(store)).length, 1);
});

test("replies: a supplier reply is logged once, marks the supplier replied, and is stored as a safe cell", async () => {
  const store = new MemoryStore();
  await store.put("rfqs", "rfq-001", rfq());
  await run("issue", store);
  replyList = [
    { id: "AAMkReply1", subject: "Re: RFQ rfq-001: Precast panels, Lot 4", from: { emailAddress: { address: ARI.toUpperCase() } },
      receivedDateTime: "2026-11-10T01:00:00Z", bodyPreview: "=HYPERLINK(\"x\") 12 panels at $412.50 ex GST" },
    { id: "AAMkOther", subject: "RFQ rfq-001", from: { emailAddress: { address: "stranger@elsewhere.example" } }, receivedDateTime: "2026-11-10T02:00:00Z", bodyPreview: "hi" },
  ];
  hits = [];
  await run("replies", store);
  const rows = hits.filter((h) => h.path.endsWith("/rows"));
  assert.equal(rows.length, 1, "one reply logged, the stranger ignored");
  assert.equal(rows[0].body.values[0][4], "Reply");
  assert.equal(rows[0].body.values[0][5].startsWith("'="), true, "a formula-like preview is stored as text");
  const stored = await store.get<any>("rfqs", "rfq-001");
  assert.deepEqual(stored.replied, [ARI]);

  hits = [];
  await run("replies", store);
  assert.equal(hits.filter((h) => h.path.endsWith("/rows")).length, 0, "a re-run never logs the same reply twice");
});

test("chase: a due chaser goes only to a supplier who has not replied, and a re-run adds nothing", async () => {
  const store = new MemoryStore();
  await store.put("rfqs", "rfq-001", rfq());
  await run("issue", store);
  for (const a of await approvals(store)) await approve(WF, store, a.id, "oscar", NOW);
  await store.put("rfqs", "rfq-001", { ...(await store.get<any>("rfqs", "rfq-001")), replied: [ARI] });
  const later = new Date(NOW.getTime() + 4 * 864e5);
  hits = [];
  await run("chase", store, later);
  assert.equal(sends().length, 0, "a chaser is never sent by the cron");
  const chasers = await approvals(store);
  const chaser = chasers.filter((a) => a.acts[0].key?.startsWith("chase1:"));
  assert.equal(chaser.length, 1);
  assert.match(chaser[0].acts[0].key!, new RegExp(SAM));
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages")).length, 1);

  hits = [];
  await run("chase", store, later);
  assert.equal(hits.length, 0, "the round is done once");
  assert.equal((await approvals(store)).length, chasers.length);
});

test("chase: a supplier whose RFQ send was rejected or is still waiting gets no chaser", async () => {
  const store = new MemoryStore();
  await store.put("rfqs", "rfq-001", rfq());
  await run("issue", store);
  const [ariSend, samSend] = [`send:rfq-001:${ARI}`, `send:rfq-001:${SAM}`].map((k) => approvalId(WF.id, k));
  await approve(WF, store, ariSend, "oscar", NOW);
  await reject(WF, store, samSend, "oscar", NOW);
  const later = new Date(NOW.getTime() + 4 * 864e5);
  hits = [];
  await run("chase", store, later);
  const chasers = (await approvals(store)).filter((a) => a.acts[0].key?.startsWith("chase1:"));
  assert.equal(chasers.length, 1, "only the supplier who received the RFQ is chased");
  assert.match(chasers[0].acts[0].key!, new RegExp(ARI));
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages")).length, 1);
});

test("purchase order: drafted in Xero, authorise only queued, and it runs only on approval", async () => {
  const store = new MemoryStore();
  await store.put("rfqs", "rfq-001", rfq({ status: "issued", issued_at: NOW.toISOString(), award: {
    supplier: { name: "Ari Shah", email: ARI }, xero_contact_id: CONTACT, lines: [{ item: "Precast panel 3.0 m", qty: 12, unitPrice: 412.5 }] } }));
  await run("purchase-order", store);
  const draft = hits.find((h) => h.method === "PUT" && h.path.endsWith("/PurchaseOrders"));
  assert.ok(draft, "the purchase order is drafted");
  assert.equal(draft!.body.PurchaseOrders[0].Status, "DRAFT");
  assert.equal(draft!.body.PurchaseOrders[0].Contact.ContactID, CONTACT);
  assert.match(String(draft!.headers?.["Idempotency-Key"]), /^rfq-po:rfq-001$/, "the draft carries an idempotency key from the RFQ id");
  assert.equal(hits.some((h) => h.method === "POST" && h.path.includes("/PurchaseOrders/")), false, "nothing is authorised by the cron");
  const aps = await approvals(store);
  assert.equal(aps.length, 1);
  assert.equal(aps[0].acts[0].op, "accounting.updatePurchaseOrder");
  assert.equal(aps[0].status, "pending");

  hits = [];
  await run("purchase-order", store);
  assert.equal(hits.filter((h) => h.method === "PUT").length, 0, "a re-run never drafts a second purchase order");
  assert.equal((await approvals(store)).length, 1);

  await approve(WF, store, aps[0].id, "oscar", NOW);
  const authorised = hits.find((h) => h.method === "POST" && h.path.endsWith(`/PurchaseOrders/${PO}`));
  assert.ok(authorised, "approval authorises the purchase order");
  assert.equal(authorised!.body.PurchaseOrders[0].Status, "AUTHORISED");
});

test("purchase order: a bad Xero contact id is refused and nothing is drafted", async () => {
  const store = new MemoryStore();
  await store.put("rfqs", "rfq-001", rfq({ status: "issued", issued_at: NOW.toISOString(), award: {
    supplier: { name: "Ari Shah", email: ARI }, xero_contact_id: "not-a-uuid", lines: [{ item: "Panel", qty: 1, unitPrice: 1 }] } }));
  await run("purchase-order", store);
  assert.equal(hits.filter((h) => h.method === "PUT").length, 0);
  assert.equal((await approvals(store)).length, 0);
});
