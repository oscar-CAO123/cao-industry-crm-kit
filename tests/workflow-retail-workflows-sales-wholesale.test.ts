// Wholesale workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { accountSetup, invoice, chase } from "../industries/retail/workflows/sales/wholesale/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/retail/workflows/sales/wholesale/workflow.json", "utf8")) as WorkflowRecord;
const CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef";
type Hit = { method: string; path: string; body: any; headers: Record<string, string> };
let hits: Hit[] = [];
let overdueRows: any[] = [];

function fake() {
  hits = []; overdueRows = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, headers: init?.headers ?? {} });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Contacts")) return json(m === "GET" ? { Contacts: [] } : { Contacts: [{ ContactID: CID }] });
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: overdueRows });
      if (p.endsWith("/Invoices")) return json({ Invoices: [{ InvoiceID: INV, Status: m === "POST" ? "AUTHORISED" : "DRAFT" }] });
      if (p.endsWith(`/Invoices/${INV}/Email`)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = (path: RegExp) => hits.filter((h) => path.test(h.path));
const invoiceDrafts = () => hits.filter((h) => h.path.endsWith("/Invoices") && h.method === "PUT");
const authorises = () => hits.filter((h) => h.path.endsWith("/Invoices") && h.method === "POST");
const emails = () => writes(new RegExp(`/Invoices/${INV}/Email$`));

const SETTINGS: any = { family: "wholesale", business_name: "Test Wholesale", invoice: { payment_terms_days: 30 }, chase: { after_days_overdue: [7, 14, 30] } };
const NOW = new Date("2026-11-08T00:00:00Z");
const ACCOUNT = { id: "acc-1", name: "Run Club Co", email: "buyer@example.com", status: "new" };
const ORDER = { id: "ord-1", account: "acc-1", po: "PO-0001", status: "ready", lines: [{ description: "Trail tee", qty: 12, unitPrice: 45 }] };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("a cron cannot run a live operation, and cannot queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.emailInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.getContacts", summary: "x" }), /not a live operation/);
});

test("the record keeps every send and authorise out of draft_ops", () => {
  assert.ok(!WF.draft_ops.xero.includes("accounting.emailInvoice"));
  assert.ok(!WF.draft_ops.xero.includes("accounting.updateOrCreateInvoices"));
  assert.ok(WF.live_ops.xero.includes("accounting.emailInvoice"));
  assert.ok(WF.live_ops.xero.includes("accounting.updateOrCreateInvoices"));
});

test("account to invoice: contact and DRAFT invoice are drafts, the send is queued once and runs only on approval", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("accounts", ACCOUNT.id, ACCOUNT);
  await store.put("orders", ORDER.id, ORDER);

  assert.deepEqual(await accountSetup(ctx), { set: 1, held: 0 });
  assert.equal((await store.get<any>("accounts", ACCOUNT.id)).xero_contact_id, CID);

  assert.deepEqual(await invoice(ctx), { drafted: 1, queued: 1, held: 0, sent: 0, rejected: 0 });
  const draft = invoiceDrafts()[0].body.Invoices[0];
  assert.equal(draft.Status, "DRAFT");
  assert.equal(draft.Type, "ACCREC");
  assert.equal(draft.DueDate, "2026-12-08", "payment terms: 30 days from the order date");
  assert.deepEqual(draft.LineItems, [{ Description: "Trail tee", Quantity: 12, UnitAmount: 45 }]);
  assert.equal(authorises().length + emails().length, 0, "nothing authorised or emailed by a cron");

  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].acts.map((a) => a.op), ["accounting.updateOrCreateInvoices", "accounting.emailInvoice"]);
  assert.match(pending[0].summary, /1 lines, \$540\.00 ex GST/);

  await invoice(ctx); await accountSetup(ctx);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
  assert.equal(invoiceDrafts().length, 1, "re-runs never draft twice");

  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(authorises()[0].body.Invoices[0].Status, "AUTHORISED");
  assert.equal(emails().length, 1, "emailed once, by approval");
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);

  assert.deepEqual(await invoice(ctx), { drafted: 0, queued: 0, held: 0, sent: 1, rejected: 0 });
  assert.equal((await store.get<Order>("orders", ORDER.id))!.status, "invoiced");
});

test("an overdue invoice gets one chase queued at its step, and not again until the next step", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("accounts", ACCOUNT.id, { ...ACCOUNT, status: "contact-ready", xero_contact_id: CID });
  await store.put("orders", ORDER.id, { ...ORDER, status: "invoiced", invoice_id: INV, due: "2026-11-20" });
  overdueRows = [{ InvoiceID: INV, InvoiceNumber: "INV-0001", DueDate: "2026-11-20", AmountDue: 540, Status: "AUTHORISED" }];

  const late = new Date("2026-12-20T00:00:00Z"); // 30 days after the due date: all three steps reached
  assert.deepEqual(await chase(context(WF, SETTINGS, store, late, () => {})), { queued: 1 });
  assert.equal(emails().length, 0, "a chase is only queued");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.id, approvalId(WF.id, `chase:${ORDER.id}:3`));
  assert.deepEqual(await chase(context(WF, SETTINGS, store, late, () => {})), { queued: 0 }, "the same step is never queued twice");

  await approve(WF, store, ap.id, "owner", late);
  assert.equal(emails().length, 1);
  assert.equal(emails()[0].headers["Idempotency-Key"], "chase:ord-1:3");
});

test("an order with a bad line is held and never reaches Xero", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("accounts", ACCOUNT.id, { ...ACCOUNT, status: "contact-ready", xero_contact_id: CID });
  await store.put("orders", "ord-2", { ...ORDER, id: "ord-2", lines: [{ description: "Trail tee", qty: 0, unitPrice: 45 }] });
  assert.deepEqual(await invoice(ctx), { drafted: 0, queued: 0, held: 1, sent: 0, rejected: 0 });
  assert.equal(invoiceDrafts().length, 0);
  assert.equal((await store.get<any>("orders", "ord-2")).status, "held");
});

test("a stockist with no valid email is held before any invoice is drafted", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("accounts", ACCOUNT.id, { ...ACCOUNT, email: "not-an-email", status: "contact-ready", xero_contact_id: CID });
  await store.put("orders", ORDER.id, ORDER);
  assert.deepEqual(await invoice(ctx), { drafted: 0, queued: 0, held: 1, sent: 0, rejected: 0 });
  assert.equal(invoiceDrafts().length, 0);
});

// Typed Order for the assertions above.
type Order = import("../industries/retail/workflows/sales/wholesale/types.ts").Order;
