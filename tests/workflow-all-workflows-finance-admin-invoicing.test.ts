// Invoicing workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { draft, payments, chase } from "../industries/all/workflows/finance-admin/invoicing/index.ts";
import type { Settings } from "../industries/all/workflows/finance-admin/invoicing/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/finance-admin/invoicing/workflow.json", "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", JOB2 = "22222222-3333-4444-8555-666666666666", COMP = "33333333-4444-4555-8666-777777777777";
const PAY = "44444444-5555-4666-8777-888888888888", CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const NOW = new Date("2026-11-08T00:00:00Z");
const S: Settings = { business_name: "Test Electrical", due_days: 14, sales_account_code: "200", bank_account_code: "090",
  mark_invoice_sent: true, chase_after_days_past_due: [7, 21] };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let xeroStatus = "DRAFT", amountDue = 0, sent = false, dueStr = "2026-11-22T00:00:00";
let payState: { uuid: string; job_uuid: string; amount: string; active: number }[] = [];

function fake() {
  hits = []; xeroStatus = "DRAFT"; amountDue = 0; sent = false; dueStr = "2026-11-22T00:00:00";
  payState = [{ uuid: PAY, job_uuid: JOB, amount: "200.00", active: 1 }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // ServiceM8
      if (p.endsWith("/job.json")) return json([
        { uuid: JOB, status: "Completed", active: 1, company_uuid: COMP, job_description: "Hot water unit", invoice_sent: 0 },
        { uuid: JOB2, status: "Completed", active: 1, company_uuid: COMP, job_description: "Callout", invoice_sent: 0 }]);
      if (p.endsWith("/jobmaterial.json")) return json(String(u.searchParams.get("$filter")).includes(JOB)
        ? [{ name: "Hot water unit", quantity: "1", price: "450.00", active: 1 }, { name: "Labour", quantity: "2", price: "95", active: 1 }] : []);
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", is_primary_contact: "1" }]);
      if (p.endsWith("/jobpayment.json")) return json(payState);
      if (p.endsWith(`/job/${JOB}.json`)) return json({ errorCode: 0 });
      // Xero
      if (p.endsWith("/Contacts")) return json(m === "GET" ? { Contacts: [{ ContactID: CID, EmailAddress: "sam@example.com" }] } : { Contacts: [{ ContactID: CID }] });
      if (p.endsWith("/Invoices") && m === "PUT") { xeroStatus = "DRAFT"; amountDue = 640; return json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT" }] }); }
      if (p.endsWith("/Invoices") && m === "POST") { xeroStatus = "AUTHORISED"; return json({ Invoices: [{ InvoiceID: INV, Status: "AUTHORISED" }] }); }
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: [{ InvoiceID: INV, Status: xeroStatus, AmountDue: amountDue, DueDate: dueStr, SentToContact: sent }] });
      if (p.endsWith(`/Invoices/${INV}/Email`)) { sent = true; return json({}); }
      if (p.endsWith("/Payments")) { amountDue = Math.round((amountDue - Number(body.Amount)) * 100) / 100; return json({ Payments: [{ PaymentID: "pay-1" }] }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

/** Anything that authorises, emails, pays or marks a job invoiced. A cron must never produce one. */
const liveEffects = () => hits.filter((h) => h.method === "POST" && (h.path.endsWith("/Invoices") || h.path.endsWith("/Email")
  || h.path.endsWith("/Payments") || h.path.endsWith(`/job/${JOB}.json`)));
const count = (pred: (h: Hit) => boolean) => hits.filter(pred).length;

/** Drafts the invoice for JOB and approves its send, the way a person would. */
async function sentInvoice(store: MemoryStore) {
  const ctx = context(WF, S, store, NOW, () => {});
  await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  return ctx;
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("guard: a draft cannot run a live operation, and a live operation cannot be queued as a draft", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.emailInvoice", input: { params: { InvoiceID: INV }, body: {} }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "servicem8-api.updateJobs", input: { params: { uuid: JOB }, body: {} }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0, "nothing reached the network");
});

test("draft: one DRAFT invoice per completed job with materials, its send queued once, nothing sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await draft(ctx), { drafted: 1, parked: 1 });
  const creates = hits.filter((h) => h.method === "PUT" && h.path.endsWith("/Invoices"));
  assert.equal(creates.length, 1);
  const inv = creates[0].body.Invoices[0];
  assert.equal(inv.Status, "DRAFT");
  assert.equal(inv.Reference, JOB);
  assert.equal(inv.Contact.ContactID, CID);
  assert.deepEqual(inv.LineItems.map((l: any) => [l.Description, l.Quantity, l.UnitAmount, l.AccountCode]),
    [["Hot water unit", 1, 450, "200"], ["Labour", 2, 95, "200"]]);
  assert.equal(liveEffects().length, 0, "a cron authorises, emails and pays nothing");
  assert.equal(count((h) => h.method === "GET" && h.path.endsWith("/Contacts")), 1, "only the job with materials reached Xero");
  assert.equal((await store.get<{ status: string }>("invoices", JOB2))!.status, "needs-lines");
  // Re-run: no second invoice, no second approval.
  assert.deepEqual(await draft(ctx), { drafted: 0, parked: 1 });
  assert.equal(count((h) => h.method === "PUT" && h.path.endsWith("/Invoices")), 1);
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].acts.map((a) => a.op), ["accounting.updateOrCreateInvoices", "accounting.emailInvoice", "servicem8-api.updateJobs"]);
  assert.equal(liveEffects().length, 0);
});

test("approval authorises, emails and marks the job invoiced, in that order, and only once", async () => {
  const store = new MemoryStore();
  await sentInvoice(store);
  const idxAuth = hits.findIndex((h) => h.method === "POST" && h.path.endsWith("/Invoices"));
  const idxMail = hits.findIndex((h) => h.method === "POST" && h.path.endsWith(`/Invoices/${INV}/Email`));
  const idxMark = hits.findIndex((h) => h.method === "POST" && h.path.endsWith(`/job/${JOB}.json`));
  assert.ok(idxAuth > -1 && idxAuth < idxMail && idxMail < idxMark, "authorise, then email, then mark");
  assert.deepEqual(hits[idxAuth].body, { Invoices: [{ InvoiceID: INV, Status: "AUTHORISED" }] });
  assert.deepEqual(hits[idxMark].body, { invoice_sent: 1 });
  assert.equal(liveEffects().length, 3);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(liveEffects().length, 3, "a second approve sends nothing");
});

test("a payment the trade took is queued against the Xero invoice, never recorded directly, and only once", async () => {
  const store = new MemoryStore();
  const ctx = await sentInvoice(store);
  assert.deepEqual(await payments(ctx), { queued: 1, parked: 0 });
  assert.equal(count((h) => h.method === "POST" && h.path.endsWith("/Payments")), 0, "nothing recorded by the cron");
  assert.deepEqual(await payments(ctx), { queued: 0, parked: 0 }, "re-runs never queue the same payment twice");
  const pay = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].op === "accounting.createPayment")!;
  assert.equal(pay.acts[0].key, `payment:${PAY}`);
  await approve(WF, store, pay.id, "owner", NOW);
  const posted = hits.find((h) => h.method === "POST" && h.path.endsWith("/Payments"))!.body;
  assert.deepEqual({ invoice: posted.Invoice, code: posted.Account.Code, amount: posted.Amount },
    { invoice: { InvoiceID: INV }, code: "090", amount: 200 });
});

test("a payment parked for a missing bank code is queued once the setting is fixed, and only then", async () => {
  const store = new MemoryStore();
  const ctx = await sentInvoice(store);
  const noBank = context(WF, { ...S, bank_account_code: undefined }, store, NOW, () => {});
  assert.deepEqual(await payments(noBank), { queued: 0, parked: 1 });
  assert.equal((await store.get<{ status: string }>("payments", PAY))!.status, "parked");
  assert.equal(Object.values(await store.list<Approval>("approvals")).filter((a) => a.acts[0].op === "accounting.createPayment").length, 0);
  assert.deepEqual(await payments(ctx), { queued: 1, parked: 0 }, "the parked payment is queued after the fix");
  assert.deepEqual(await payments(ctx), { queued: 0, parked: 0 }, "and never queued a second time");
  assert.equal(count((h) => h.method === "POST" && h.path.endsWith("/Payments")), 0, "nothing recorded by the cron");
});

test("chase: a sent invoice past due gets its reminder queued, not sent, and step 2 waits for its own day count", async () => {
  const store = new MemoryStore();
  const ctx = await sentInvoice(store);
  dueStr = `/Date(${Date.parse("2026-10-31T00:00:00Z")}+0000)/`; // 8 days past due
  const emailsBefore = count((h) => h.method === "POST" && h.path.endsWith("/Email"));
  assert.deepEqual(await chase(ctx), { queued: 1 });
  assert.equal(count((h) => h.method === "POST" && h.path.endsWith("/Email")), emailsBefore, "queued, not sent");
  assert.deepEqual(await chase(ctx), { queued: 0 }, "step 1 is done; step 2 waits for 21 days past due");
  const reminder = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].op === "accounting.emailInvoice")!;
  assert.equal(reminder.status, "pending");
  await approve(WF, store, reminder.id, "owner", NOW);
  assert.equal(count((h) => h.method === "POST" && h.path.endsWith("/Email")), emailsBefore + 1);
});

test("chase: an invoice not yet past its reminder day is left alone", async () => {
  const store = new MemoryStore();
  const ctx = await sentInvoice(store);
  dueStr = "2026-11-05T00:00:00"; // 3 days past due
  assert.deepEqual(await chase(ctx), { queued: 0 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "only the send approval exists");
});
