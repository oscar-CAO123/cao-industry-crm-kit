// Bills and expenses workflow tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe } from "../core/sdk/call.ts";
import { enter, review, CRONS } from "../industries/all/workflows/finance-admin/bills-expenses/index.ts";
import { render, TARGETS } from "../tools/deploy.ts";
import type { Bill } from "../industries/all/workflows/finance-admin/bills-expenses/types.ts";

const DIR = "industries/all/workflows/finance-admin/bills-expenses";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8"));
const CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef", PO = "12345678-1234-4234-8234-123456789012";
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; url: string; body: any };
let hits: Hit[] = [];
let poSubtotal = 300, dupe = false, overdueRows: any[] = [], contactIsCustomer = false;

function fake() {
  hits = []; poSubtotal = 300; dupe = false; contactIsCustomer = false;
  overdueRows = [
    { InvoiceID: INV, InvoiceNumber: "OLD-1", Type: "ACCPAY", Status: "AUTHORISED", AmountDue: 110, DueDate: "2026-10-30T00:00:00", Contact: { Name: "Acme Supplies" } },
    { InvoiceID: "11111111-2222-4333-8444-555555555555", InvoiceNumber: "NEW-2", Type: "ACCPAY", Status: "AUTHORISED", AmountDue: 55, DueDate: "2026-12-01T00:00:00", Contact: { Name: "Bolt Co" } },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, url: u.toString(), body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Contacts") && m === "GET") return json({ Contacts: contactIsCustomer ? [{ ContactID: CID, Name: "Acme Supplies", IsSupplier: false }] : [] });
      if (p.endsWith("/Contacts") && m === "PUT") return json({ Contacts: [{ ContactID: CID, Name: "Acme Supplies", IsSupplier: true }] });
      if (p.endsWith("/Accounts")) return json({ Accounts: [{ Code: "300", Name: "Materials" }, { Code: "400", Name: "Subcontractors" }] });
      if (p.endsWith("/PurchaseOrders")) return json({ PurchaseOrders: [{ PurchaseOrderID: PO, PurchaseOrderNumber: "PO-100", SubTotal: poSubtotal, Total: poSubtotal * 1.1 }] });
      if (p.endsWith("/Invoices") && m === "GET" && u.searchParams.get("Statuses") === "AUTHORISED") return json({ Invoices: overdueRows });
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: dupe ? [{ InvoiceID: INV, Type: "ACCPAY", InvoiceNumber: "INV-7" }] : [] });
      if (p.endsWith("/Invoices") && m === "PUT") return json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT", Type: "ACCPAY" }] });
      if (p.endsWith("/Invoices") && m === "POST") return json({ Invoices: [{ InvoiceID: INV, Status: "AUTHORISED" }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const bill = (over: Partial<Bill> = {}): Bill => ({
  supplier: "Acme Supplies", supplier_email: "accounts@acme.example", invoice_number: "INV-7", date: "2026-11-01", due_date: "2026-11-30",
  po_number: "PO-100", lines: [{ description: "Cable 2.5mm", amount: 200, account_code: "300" }, { description: "Labour", amount: 100, account_code: "400" }],
  source: "emailed PDF", received: "2026-11-02T00:00:00Z", status: "new", ...over,
});
const writes = () => hits.filter((h) => h.method !== "GET");
const billPuts = () => hits.filter((h) => h.method === "PUT" && h.path.endsWith("/Invoices"));
const envFor = (allow = "1") => Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: allow });

beforeEach(() => { fake(); setTokenStore(new MemoryTokenStore()); envFor(); });

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateOrCreateInvoices", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("every operation the workflow names exists in the kit", () => {
  for (const ops of [WF.draft_ops, WF.live_ops]) for (const [platform, list] of Object.entries(ops)) for (const op of list) assert.doesNotThrow(() => describe(platform, op), `${platform} ${op}`);
});

test("enter: a clean bill is entered as a DRAFT ACCPAY bill, and its authorisation is queued, never sent", async () => {
  const store = new MemoryStore();
  await store.put("bills", "acme-inv-7", bill());
  await enter(context(WF, SETTINGS, store, NOW, () => {}));
  const put = billPuts();
  assert.equal(put.length, 1);
  const inv = put[0].body.Invoices[0];
  assert.equal(inv.Type, "ACCPAY"); assert.equal(inv.Status, "DRAFT"); assert.equal(inv.LineAmountTypes, "Exclusive");
  assert.deepEqual(inv.LineItems.map((l: any) => [l.AccountCode, l.UnitAmount, l.TaxType]), [["300", 200, "INPUT"], ["400", 100, "INPUT"]]);
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/Invoices")).length, 0, "nothing authorised before approval");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.deepEqual(aps[0].acts.map((a) => a.op), ["accounting.updateOrCreateInvoices"]);
  assert.equal((await store.get<Bill>("bills", "acme-inv-7"))!.status, "entered");
});

test("enter: a second run creates no second bill and queues no second approval", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await store.put("bills", "acme-inv-7", bill());
  await enter(ctx()); await enter(ctx());
  assert.equal(billPuts().length, 1);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("enter: the approval authorises the bill once, and a second approve is refused", async () => {
  const store = new MemoryStore();
  await store.put("bills", "acme-inv-7", bill());
  await enter(context(WF, SETTINGS, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  const post = hits.filter((h) => h.method === "POST" && h.path.endsWith("/Invoices"));
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].body, { Invoices: [{ InvoiceID: INV, Status: "AUTHORISED" }] });
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("enter: an account code outside the chart parks the bill as needs-coding, with no bill created", async () => {
  const store = new MemoryStore();
  await store.put("bills", "acme-inv-7", bill({ lines: [{ description: "Tools", amount: 80, account_code: "999" }] }));
  await enter(context(WF, SETTINGS, store, NOW, () => {}));
  const b = await store.get<Bill>("bills", "acme-inv-7");
  assert.equal(b!.status, "needs-coding");
  assert.match(b!.reason!, /999/);
  assert.equal(billPuts().length, 0);
});

test("enter: a bill already in Xero is marked duplicate and nothing is entered", async () => {
  const store = new MemoryStore();
  dupe = true;
  await store.put("bills", "acme-inv-7", bill());
  await enter(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal((await store.get<Bill>("bills", "acme-inv-7"))!.status, "duplicate");
  assert.equal(billPuts().length, 0);
});

test("enter: a purchase order that does not match the bill parks it as needs-review", async () => {
  const store = new MemoryStore();
  poSubtotal = 250;
  await store.put("bills", "acme-inv-7", bill());
  await enter(context(WF, SETTINGS, store, NOW, () => {}));
  const b = await store.get<Bill>("bills", "acme-inv-7");
  assert.equal(b!.status, "needs-review");
  assert.match(b!.reason!, /PO-100/);
  assert.equal(billPuts().length, 0);
});

test("enter: a customer in Xero with the supplier's name is not used, and the bill is parked", async () => {
  const store = new MemoryStore();
  contactIsCustomer = true;
  await store.put("bills", "acme-inv-7", bill({ po_number: undefined }));
  await enter(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal((await store.get<Bill>("bills", "acme-inv-7"))!.status, "needs-review");
  assert.equal(billPuts().length, 0);
});

test("enter: a bad invoice number is refused before any network call", async () => {
  const store = new MemoryStore();
  await store.put("bills", "bad", bill({ invoice_number: "INV-1'; DROP" }));
  await enter(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal((await store.get<Bill>("bills", "bad"))!.status, "needs-review");
  assert.equal(hits.length, 0);
});

test("enter: with writes blocked the run stops and does not park the bill", async () => {
  const store = new MemoryStore();
  envFor("0");
  await store.put("bills", "acme-inv-7", bill());
  await assert.rejects(enter(context(WF, SETTINGS, store, NOW, () => {})), WriteBlocked);
  assert.equal((await store.get<Bill>("bills", "acme-inv-7"))!.status, "new");
});

test("review: lists only past-due authorised bills and writes nothing to Xero", async () => {
  const store = new MemoryStore();
  await review(context(WF, SETTINGS, store, NOW, () => {}));
  const latest = await store.get<any>("overdue", "latest");
  assert.equal(latest.count, 1);
  assert.equal(latest.bills[0].number, "OLD-1");
  assert.equal(latest.owing_total, 110);
  assert.equal(writes().length, 0);
});

test("deploy: every target renders both crons with no key values", () => {
  for (const t of TARGETS) {
    const all = Object.values(render(DIR, SETTINGS, t)).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    assert.ok(!/\b(x|y|r1|tok)\b.*XERO|Bearer [A-Za-z0-9]{8}/.test(all), `${t} carries no key values`);
  }
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});
