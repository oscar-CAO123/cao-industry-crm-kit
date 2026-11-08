// Order-sync workflow tests. Every request goes to a fake network: no test reaches a real Cin7 or Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe as describeOp } from "../core/sdk/call.ts";
import { intake, stockCheck, invoice, billMatch, CRONS } from "../industries/all/workflows/fulfilment/order-sync/index.ts";
import { checkReorder, type Settings } from "../industries/all/workflows/fulfilment/order-sync/types.ts";

const DIR = "industries/all/workflows/fulfilment/order-sync";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef", BILL_DRAFT = "abcdefab-cdef-4abc-8def-abcdef000001";
const NOW = new Date("2026-11-08T00:00:00Z");
const SETTINGS: Settings = {
  business_name: "Test Supplies",
  reorder: [{ code: "BOLT-M8", name: "M8 bolt", supplier_member_id: 42, supplier_name: "Example Fasteners", unit_price: 0.25, order_qty: 500 }],
  invoice: { on_ship: "xero-invoice-draft", due_days: 30 },
};

const SO_OPEN = { id: 101, reference: "WEB-101", company: "", firstName: "Sam", lastName: "Lee", email: "sam@example.com", modifiedDate: "2026-11-07T10:00:00Z",
  isVoid: false, dispatchedDate: null, lineItems: [{ code: "BOLT-M8", name: "M8 bolt", qty: 600, qtyShipped: 0, unitPrice: 0.5 }] };
const SO_SHIPPED = { id: 102, reference: "WEB-102", company: "Harbour Hardware", email: "buy@harbour.example", modifiedDate: "2026-11-07T11:00:00Z",
  isVoid: false, dispatchedDate: "2026-11-07T11:00:00Z", lineItems: [{ code: "BOLT-M8", name: "M8 bolt", qty: 20, qtyShipped: 20, unitPrice: 0.5 }] };

type Hit = { method: string; path: string; body: any; idem?: string };
let hits: Hit[] = [];
let salesOrders: any[] = [], stock: any[] = [], purchaseOrders: any[] = [], bills: any[] = [];

function fake() {
  hits = []; salesOrders = []; stock = []; purchaseOrders = []; bills = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, idem: new Headers(init?.headers ?? {}).get("idempotency-key") ?? undefined });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Cin7
      if (p.endsWith("/SalesOrders") && m === "GET") return json(salesOrders);
      if (p.endsWith("/Stock") && m === "GET") return json(stock);
      if (p.endsWith("/PurchaseOrders") && m === "GET") return json(purchaseOrders);
      if (p.endsWith("/PurchaseOrders") && m === "POST") return json([{ id: 555, statusCode: 200 }]);
      // Xero
      if (p.endsWith("/Contacts") && m === "GET") return json({ Contacts: [] });
      if (p.endsWith("/Contacts") && m === "PUT") return json({ Contacts: [{ ContactID: CID }] });
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: bills });
      if (p.endsWith("/Invoices") && m === "PUT") return json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT" }] });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { CIN7_USERNAME: "u", CIN7_API_KEY: "k", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("the record matches the kit: every operation is mapped and every cron has an entry", () => {
  for (const [platform, ops] of Object.entries({ ...WF.draft_ops, ...WF.live_ops })) for (const op of ops) describeOp(platform, op);
  for (const c of WF.crons) assert.ok(CRONS[c.entry], `cron ${c.name} has no entry ${c.entry}`);
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.ok(!(WF.draft_ops.cin7 ?? []).includes("post /api/v1/PurchaseOrders"), "a purchase order is a live operation");
  assert.ok(!(WF.draft_ops.xero ?? []).some((op) => /Authoris|Email|Payment|Void|Delete/i.test(op)), "no send, payment or delete in draft_ops");
});

test("runtime: a cron cannot run a live operation and cannot queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "cin7", op: "post /api/v1/PurchaseOrders", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "cin7", op: "get /api/v1/SalesOrders", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.deleteInvoices", summary: "x" }), /not a draft operation/);
});

test("bad reorder settings are refused before any call", async () => {
  assert.throws(() => checkReorder([{ ...SETTINGS.reorder![0], code: "BOLT'M8" }]), /bad product code/);
  const store = new MemoryStore();
  await assert.rejects(stockCheck(context(WF, { ...SETTINGS, reorder: [{ ...SETTINGS.reorder![0], supplier_member_id: 0 }] }, store, NOW, () => {})), /bad supplier id/);
  assert.equal(hits.length, 0);
});

test("intake reads sales orders into the order book and does not read them twice", async () => {
  salesOrders = [SO_SHIPPED, SO_OPEN];
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  assert.equal((await intake(ctx())).read, 2);
  const open = await store.get<any>("orders", "so-101");
  assert.equal(open.status, "open");
  assert.equal((await store.get<any>("orders", "so-102")).status, "shipped");
  assert.equal((await intake(ctx())).read, 0, "a second run finds nothing newer than the watermark");
});

test("stock-check queues a purchase order for approval, never raises it, and queues it once a day", async () => {
  salesOrders = [SO_OPEN];
  stock = [{ code: "BOLT-M8", available: 100, branchName: "Main" }];
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx());
  await stockCheck(ctx());
  await stockCheck(ctx());
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1, "a second run the same day does not queue again");
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].acts[0].op, "post /api/v1/PurchaseOrders");
  assert.equal(writes().filter((h) => h.path.endsWith("/PurchaseOrders")).length, 0, "nothing is raised before approval");

  const done = await approve(WF, store, approvals[0].id, "oscar", NOW);
  assert.equal(done.status, "done");
  assert.equal(done.results?.[0]?.ref?.id, "555", "the created purchase order id is kept");
  const po = writes().find((h) => h.path.endsWith("/PurchaseOrders"));
  assert.equal(po?.body?.[0]?.memberId, 42);
  assert.equal(po?.body?.[0]?.lineItems?.[0]?.qty, 500);

  await stockCheck(ctx());
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "a run after approval does not queue it again");
});

test("invoice drafts one DRAFT Xero invoice per shipped order, with an idempotency key", async () => {
  salesOrders = [SO_SHIPPED];
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx());
  assert.deepEqual(await invoice(ctx()), { drafted: 1, failed: 0 });
  const inv = writes().find((h) => h.path.endsWith("/Invoices"));
  assert.equal(inv?.body?.Invoices?.[0]?.Status, "DRAFT");
  assert.equal(inv?.body?.Invoices?.[0]?.Type, "ACCREC");
  assert.equal(inv?.idem, "invoice-so-102");
  assert.equal((await store.get<any>("orders", "so-102")).xero_invoice, INV);
  await invoice(ctx());
  assert.equal(writes().filter((h) => h.path.endsWith("/Invoices")).length, 1, "a shipped order is invoiced once");
});

test("bill-match records an amount mismatch and writes nothing to either platform", async () => {
  bills = [
    { InvoiceID: INV, Type: "ACCPAY", Status: "AUTHORISED", Reference: "PO-7", Contact: { Name: "Example Fasteners" }, SubTotal: 100 },
    { InvoiceID: BILL_DRAFT, Type: "ACCPAY", Status: "DRAFT", Reference: "PO-8", Contact: { Name: "Example Fasteners" }, SubTotal: 1 },
  ];
  purchaseOrders = [{ id: 7, reference: "PO-7", company: "Example Fasteners", productTotal: 150 }];
  const store = new MemoryStore();
  const r = await billMatch(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(r, { matched: 0, mismatched: 1 });
  const m = await store.get<any>("matches", `bill-${INV}`);
  assert.equal(m.status, "mismatch");
  assert.match(m.reason, /amount/);
  assert.equal(await store.get("matches", `bill-${BILL_DRAFT}`), undefined, "a draft bill is not matched");
  assert.equal(writes().length, 0);
});

test("no cron sends, pays or authorises anything, whatever the fixtures say", async () => {
  salesOrders = [SO_OPEN, SO_SHIPPED];
  stock = [{ code: "BOLT-M8", available: 0 }];
  bills = [{ InvoiceID: INV, Type: "ACCPAY", Status: "AUTHORISED", Reference: "PO-9", Contact: { Name: "Example Fasteners" }, SubTotal: 1 }];
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  for (const entry of Object.values(CRONS)) await entry(ctx());
  const bad = writes().filter((h) => !(h.path.endsWith("/Contacts") || h.path.endsWith("/Invoices")) || (h.path.endsWith("/Invoices") && h.body?.Invoices?.[0]?.Status !== "DRAFT"));
  assert.deepEqual(bad.map((h) => `${h.method} ${h.path}`), [], "only draft contacts and draft invoices are written by the crons");
  assert.ok(!writes().some((h) => h.path.endsWith("/PurchaseOrders")), "the purchase order is queued, not raised");
});
