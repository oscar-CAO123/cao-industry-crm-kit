// Supplier production workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, monitor, deposit } from "../industries/retail/workflows/fulfilment/supplier-production/index.ts";
import { setStatus } from "../industries/retail/workflows/fulfilment/supplier-production/adapters/monday.ts";
import fs from "node:fs";

const DIR = "industries/retail/workflows/fulfilment/supplier-production";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const PO = "11111111-2222-4333-8444-555555555555", SUP = "87654321-4321-4321-8321-210987654321", BILL = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let items: any[] = [], poStatus = "DRAFT", failMonday = 0;

const ITEMS = [
  { id: "1001", name: "Spring knit run", column_values: [{ id: "status", text: "New order" }, { id: "factory", text: "Harbour Knit Co" }, { id: "delivery_date", text: "2026-11-20" }] },
  { id: "1002", name: "Licensed tee run", column_values: [{ id: "status", text: "New order" }, { id: "factory", text: "Harbour Knit Co" }, { id: "delivery_date", text: "2027-03-01" }] },
  { id: "1003", name: "Old order", column_values: [{ id: "status", text: "Shipped" }, { id: "factory", text: "Harbour Knit Co" }, { id: "delivery_date", text: "2026-11-15" }] },
  { id: "bad id; drop", name: "Injected", column_values: [{ id: "status", text: "New order" }] },
];

function fake() {
  hits = []; poStatus = "DRAFT"; failMonday = 0;
  items = JSON.parse(JSON.stringify(ITEMS));
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      // Monday (GraphQL on one path)
      if (p === "/v2" && String(body?.query ?? "").includes("items_page_by_column_values"))
        return json({ data: { items_page_by_column_values: { cursor: null, items } } });
      if (p === "/v2" && String(body?.query ?? "").includes("change_multiple_column_values")) {
        if (failMonday-- > 0) return new Response("{}", { status: 500 });
        return json({ data: { change_multiple_column_values: { id: "1001" } } });
      }
      // Xero
      if (p.endsWith("/Items")) return json({ Items: [{ ItemID: "i1", Code: "TEE-BLK", Name: "Cotton tee, black", PurchaseDetails: { UnitPrice: 4.2 } }, { ItemID: "i2", Code: "HOOD", Name: "Hoodie", PurchaseDetails: { UnitPrice: 12 } }] });
      if (p.endsWith("/Contacts") && m === "GET") return json({ Contacts: [{ ContactID: SUP, Name: "Harbour Knit Co" }] });
      if (p.endsWith("/Contacts") && m === "PUT") return json({ Contacts: [{ ContactID: SUP }] });
      if (p.endsWith("/PurchaseOrders") && m === "PUT") return json({ PurchaseOrders: [{ PurchaseOrderID: PO, PurchaseOrderNumber: "PO-0007", Status: "DRAFT" }] });
      if (p.endsWith(`/PurchaseOrders/${PO}`) && m === "GET") return json({ PurchaseOrders: [{ PurchaseOrderID: PO, Status: poStatus }] });
      if (p.endsWith(`/PurchaseOrders/${PO}`) && m === "POST") return json({ PurchaseOrders: [{ PurchaseOrderID: PO, Status: "AUTHORISED" }] });
      if (p.endsWith("/Invoices") && m === "PUT") return json({ Invoices: [{ InvoiceID: BILL, Status: "DRAFT" }] });
      if (p.endsWith(`/Invoices/${BILL}`) && m === "POST") return json({ Invoices: [{ InvoiceID: BILL, Status: "AUTHORISED" }] });
      if (p.endsWith("/Payments") && m === "POST") return json({ Payments: [{ PaymentID: "pay1" }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const xeroWrites = () => hits.filter((h) => h.path.includes("/api.xro/") && h.method !== "GET");
const mondayWrites = () => hits.filter((h) => h.path === "/v2" && String(h.body?.query ?? "").startsWith("mutation"));
const SETTINGS: any = {
  family: "all", business_name: "Test Apparel", production: "monday", suppliers: "xero", rate_card: "xero",
  monday: { board_id: "5000", columns: { status: "status", factory: "factory", delivery: "delivery_date" },
            labels: { new: "New order", po_drafted: "PO drafted", at_risk: "At risk", shipped: "Shipped" } },
  xero: { deposit_percent: 30, bank_account_code: "090", purchase_account_code: "300" }, delivery_warn_days: 21,
};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { MONDAY_API_TOKEN: "m", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("the workflow record: drafts never authorise, pay or delete; those are live only", () => {
  for (const op of Object.values(WF.draft_ops).flat()) assert.ok(!/update|createPayment|delete|send/i.test(op), `draft op ${op}`);
  assert.deepEqual(WF.live_ops.xero.slice().sort(), ["accounting.createPayment", "accounting.updateInvoice", "accounting.updatePurchaseOrder"]);
  assert.deepEqual(Object.keys(WF.live_ops), ["xero"]);
  assert.equal(WF.crons.length, 4);
});

test("intake turns only New order items into jobs, skips bad ids, and a re-run adds nothing", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.equal(await store.get<any>("jobs", "1003"), undefined);
  assert.equal(await store.get<any>("jobs", "1001") !== undefined, true);
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.equal(hits.filter((h) => h.method !== "GET").every((h) => h.path === "/v2" && String(h.body.query).startsWith("query")), true);
});

test("draft: a proposal drafts one purchase order and queues its authorisation, never sends it; a re-run queues nothing new", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("proposals", "1001", { lines: [{ code: "TEE-BLK", qty: 500 }] });
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_lines: 1 }); // 1002 has no proposal yet
  const pos = hits.filter((h) => h.path.endsWith("/PurchaseOrders") && h.method === "PUT");
  assert.equal(pos.length, 1);
  assert.equal(pos[0].body.PurchaseOrders[0].Status, "DRAFT");
  assert.equal(pos[0].body.PurchaseOrders[0].LineItems[0].UnitAmount, 4.2);
  assert.equal(xeroWrites().some((h) => h.path.endsWith(`/PurchaseOrders/${PO}`) && h.method === "POST"), false, "draft cron must not authorise");
  assert.equal(mondayWrites().length, 1);
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].acts[0].op, "accounting.updatePurchaseOrder");
  await draft(ctx);
  assert.equal(hits.filter((h) => h.path.endsWith("/PurchaseOrders") && h.method === "PUT").length, 1);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("draft: an order with no proposal, or an unknown item code, is parked as needs-lines and nothing is drafted", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("proposals", "1002", { lines: [{ code: "NOT-AN-ITEM", qty: 10 }] });
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_lines: 2 });
  assert.equal((await store.get<any>("jobs", "1001")).status, "needs-lines");
  assert.match((await store.get<any>("jobs", "1002")).reason, /not on the Xero items list/);
  assert.equal(hits.some((h) => h.path.endsWith("/PurchaseOrders") && h.method === "PUT"), false);
});

test("approving the queued authorisation sends the PO to AUTHORISED only when a person approves it", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("proposals", "1001", { lines: [{ code: "TEE-BLK", qty: 500 }] });
  await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const auth = hits.find((h) => h.method === "POST" && h.path.endsWith(`/PurchaseOrders/${PO}`));
  assert.equal(auth?.body.PurchaseOrders[0].Status, "AUTHORISED");
});

test("deposit: nothing happens until the PO is AUTHORISED; then one bill is drafted and one approval queues bill authorisation and the payment", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("proposals", "1001", { lines: [{ code: "TEE-BLK", qty: 500 }] });
  await draft(ctx);
  assert.deepEqual(await deposit(ctx), { queued: 0 });
  assert.equal(hits.some((h) => h.path === "/api.xro/2.0/Invoices" && h.method === "PUT"), false);
  poStatus = "AUTHORISED";
  assert.deepEqual(await deposit(ctx), { queued: 1 });
  const bill = hits.find((h) => h.path.endsWith("/Invoices") && h.method === "PUT");
  assert.equal(bill?.body.Invoices[0].Type, "ACCPAY");
  assert.equal(bill?.body.Invoices[0].Status, "DRAFT");
  assert.equal(bill?.body.Invoices[0].LineItems[0].UnitAmount, 630);
  assert.equal(hits.some((h) => h.path.endsWith("/Payments")), false, "the cron must not pay");
  const deposits = Object.values(await store.list<Approval>("approvals")).filter((a) => a.acts.some((x) => x.op === "accounting.createPayment"));
  assert.equal(deposits.length, 1);
  assert.deepEqual(deposits[0].acts.map((x) => x.op), ["accounting.updateInvoice", "accounting.createPayment"]);
  assert.deepEqual(await deposit(ctx), { queued: 0 });
  const r = await approve(WF, store, deposits[0].id, "owner", NOW);
  assert.equal(r.status, "done");
  const pay = hits.find((h) => h.path.endsWith("/Payments"));
  assert.equal(pay?.body.Amount, 630);
  assert.equal(pay?.body.Invoice.InvoiceID, BILL);
  assert.equal(pay?.body.Account.Code, "090");
});

test("monitor: an order due within the window is flagged At risk on the board, a shipped one is marked shipped, neither touches Xero", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("jobs", "1003", { id: "1003", name: "Old order", factory: "Harbour Knit Co", received: NOW.toISOString(), status: "po-drafted" });
  assert.deepEqual(await monitor(ctx), { flagged: 1 });
  assert.equal((await store.get<any>("jobs", "1001")).status, "at-risk");
  assert.equal((await store.get<any>("jobs", "1002")).status, "new");
  assert.equal((await store.get<any>("jobs", "1003")).status, "shipped");
  assert.equal(xeroWrites().length, 0);
  assert.equal(mondayWrites().length, 1);
});

test("a board write refuses an unsafe item id before any network call", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(setStatus(ctx, "1 OR 1=1", "At risk"), /bad item id/);
  assert.equal(hits.length, 0);
});
