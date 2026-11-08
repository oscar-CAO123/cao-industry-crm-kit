// Stock workflow tests. Every request goes to a fake network: no test reaches a real Xero organisation.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { stockLevels, poDraft, billMatch } from "../industries/construction/workflows/fulfilment/x-stock/index.ts";
import type { BillMatch, Request, Settings } from "../industries/construction/workflows/fulfilment/x-stock/types.ts";

const DIR = "industries/construction/workflows/fulfilment/x-stock";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const CID = "87654321-4321-4321-8321-210987654321", PO = "11111111-2222-4333-8444-555555555555";
const BILL_OVER = "abcdefab-cdef-4abc-8def-abcdefabcdef", BILL_OK = "12345678-1234-4234-8234-123456789012";
const SETTINGS: Settings = { business_name: "Test Builders",
  reorder: { "BOLTS-M8": { level: 10, order_qty: 50, supplier_email: "accounts@example-fixings.com.au", supplier_name: "Example Fixings" } } };
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [], onHand = 4, poStatus = "DRAFT";

function fake() {
  hits = []; onHand = 4; poStatus = "DRAFT";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Items")) return json({ Items: [
        { ItemID: "i1", Code: "BOLTS-M8", Name: "M8 bolts box", QuantityOnHand: onHand, PurchaseDetails: { UnitPrice: 2.5 } },
        { ItemID: "i2", Code: "PAINT-WH", Name: "White paint", QuantityOnHand: 100, PurchaseDetails: { UnitPrice: 40 } }] });
      if (p.endsWith("/Contacts")) return json({ Contacts: [{ ContactID: CID, EmailAddress: "accounts@example-fixings.com.au" }] });
      if (p.endsWith("/PurchaseOrders") && m === "PUT") return json({ PurchaseOrders: [{ PurchaseOrderID: PO, PurchaseOrderNumber: "PO-0001", Status: "DRAFT" }] });
      if (p.endsWith(`/PurchaseOrders/${PO}`) && m === "POST") { poStatus = "AUTHORISED"; return json({ PurchaseOrders: [{ PurchaseOrderID: PO, Status: "AUTHORISED" }] }); }
      if (p.endsWith("/PurchaseOrders")) return json({ PurchaseOrders: [{ PurchaseOrderID: PO, PurchaseOrderNumber: "PO-0001", Total: 250, Contact: { ContactID: CID } }] });
      if (p.endsWith("/Invoices")) return json({ Invoices: [
        { InvoiceID: BILL_OVER, Total: 260, Contact: { ContactID: CID } },
        { InvoiceID: BILL_OK, Total: 250, Contact: { ContactID: CID } }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const writes = () => hits.filter((h) => h.method !== "GET" && !/token$/.test(h.path));
const poCreates = () => hits.filter((h) => h.method === "PUT" && h.path.endsWith("/PurchaseOrders"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("a cron reads and drafts only: a low item becomes a DRAFT purchase order and a queued award", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await stockLevels(ctx), { raised: 1, closed: 0 });
  assert.deepEqual(await poDraft(ctx), { drafted: 1, skipped: 0, awarded: 0 });
  assert.equal(poCreates().length, 1);
  assert.equal(poCreates()[0].body.PurchaseOrders[0].Status, "DRAFT");
  assert.deepEqual(poCreates()[0].body.PurchaseOrders[0].LineItems.map((l: any) => [l.ItemCode, l.Quantity, l.UnitAmount]), [["BOLTS-M8", 50, 2.5]]);
  assert.equal(hits.filter((h) => h.path.includes(`/PurchaseOrders/${PO}`)).length, 0, "no cron updates a purchase order");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.deepEqual(aps[0].acts.map((a) => a.op), ["accounting.updatePurchaseOrder"]);
  assert.equal(aps[0].status, "pending");
  assert.equal(poStatus, "DRAFT");
});

test("re-runs never draft or queue a second time", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await stockLevels(ctx); await poDraft(ctx);
  await stockLevels(ctx); await poDraft(ctx);
  assert.equal(poCreates().length, 1, "one purchase order");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "one approval");
});

test("approval sets the purchase order AUTHORISED, and the next run marks the request awarded", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await stockLevels(ctx); await poDraft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const award = hits.find((h) => h.method === "POST" && h.path.endsWith(`/PurchaseOrders/${PO}`));
  assert.ok(award, "the award ran only after approval");
  assert.equal(award!.body.PurchaseOrders[0].Status, "AUTHORISED");
  assert.equal(poStatus, "AUTHORISED");
  assert.deepEqual(await poDraft(ctx), { drafted: 0, skipped: 0, awarded: 1 });
  const req = Object.values(await store.list<Request>("requests"))[0];
  assert.equal(req.status, "awarded");
});

test("draft and live operations stay apart, and writes stay gated", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updatePurchaseOrder", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createPurchaseOrders", summary: "x" }), /not a live operation/);
  process.env.KIT_ALLOW_WRITES = "0";
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createPurchaseOrders", input: { body: { PurchaseOrders: [] } }, summary: "x" }), WriteBlocked);
  assert.equal(writes().length, 0);
});

test("supplier bills are matched to their order, an over-billing is flagged, and nothing is written to Xero", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await billMatch(ctx), { matched: 1, differs: 0, over: 1, "no-order": 0 });
  const rows = Object.values(await store.list<BillMatch>("bills")).map((r) => [r.invoice, r.status]).sort();
  assert.deepEqual(rows, [[BILL_OK, "matched"], [BILL_OVER, "over"]].sort());
  assert.equal(writes().length, 0);
});
