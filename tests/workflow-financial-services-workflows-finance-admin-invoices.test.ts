// Invoice-checking workflow tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { check, payments, chase } from "../industries/financial-services/workflows/finance-admin/invoices/index.ts";

const WF = JSON.parse(fs.readFileSync("industries/financial-services/workflows/finance-admin/invoices/workflow.json", "utf8")) as WorkflowRecord;
const S: any = { business_name: "Test Accounting", bank_account_code: "090", pay_days_before_due: 2, amount_tolerance: 1, chase_after_days: [7, 14] };
const NOW = new Date("2026-11-09T00:00:00Z");
const DAY = 864e5;
const BILL_A = "aaaaaaaa-1111-4222-8333-444444444444", BILL_B = "bbbbbbbb-1111-4222-8333-444444444444", SALE_C = "cccccccc-1111-4222-8333-444444444444";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let invoices: Record<string, any> = {}, attachments: Record<string, number> = {};

function fixtures() {
  invoices = {
    [BILL_A]: { InvoiceID: BILL_A, Type: "ACCPAY", Status: "AUTHORISED", InvoiceNumber: "INV-9001", Contact: { ContactID: "c1", Name: "Lakeside Printing" },
      Date: "2026-11-02T00:00:00", DueDate: "2026-11-10T00:00:00", SubTotal: 200, Total: 220, AmountDue: 220, LineItems: [{ Description: "Printing", AccountCode: "300", LineAmount: 200 }] },
    [BILL_B]: { InvoiceID: BILL_B, Type: "ACCPAY", Status: "AUTHORISED", InvoiceNumber: "F-7", Contact: { ContactID: "c2", Name: "Ridge Fuel" },
      Date: "2026-11-05T00:00:00", DueDate: "2026-11-30T00:00:00", SubTotal: 100, Total: 110, AmountDue: 110, LineItems: [{ Description: "Fuel", LineAmount: 100 }] },
    [SALE_C]: { InvoiceID: SALE_C, Type: "ACCREC", Status: "AUTHORISED", InvoiceNumber: "INV-SALES-44", Contact: { ContactID: "c3", Name: "Harbour Cafe", EmailAddress: "accounts@harbour.example" },
      Date: "2026-10-12T00:00:00", DueDate: "2026-10-25T00:00:00", SubTotal: 455, Total: 500, AmountDue: 500, LineItems: [{ Description: "Bookkeeping", AccountCode: "200", LineAmount: 455 }] },
  };
  attachments = { [BILL_A]: 1, [BILL_B]: 0 };
}

function fake() {
  fixtures(); hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Invoices") && m === "GET") {
        const where = u.searchParams.get("where") ?? "";
        return json({ Invoices: Object.values(invoices).filter((i) => where.includes(`Type=="${i.Type}"`) && where.includes(`Status=="${i.Status}"`)) });
      }
      const one = /\/Invoices\/([^/]+)$/.exec(p);
      if (one && m === "GET") return json({ Invoices: [invoices[one[1]]] });
      const att = /\/Invoices\/([^/]+)\/Attachments$/.exec(p);
      if (att && m === "GET") return json({ Attachments: Array.from({ length: attachments[att[1]] ?? 0 }, (_, i) => ({ AttachmentID: `att${i}`, FileName: "bill.pdf" })) });
      if (/\/Invoices\/[^/]+\/History$/.test(p) && m === "PUT") return json({ HistoryRecords: [{ Details: body?.HistoryRecords?.[0]?.Details }] });
      if (p.endsWith("/Payments") && m === "POST") {
        const id = body?.Invoice?.InvoiceID;
        if (invoices[id]) invoices[id].AmountDue = 0;
        return json({ Payments: [{ PaymentID: "pay1" }] });
      }
      if (/\/Invoices\/[^/]+\/Email$/.test(p) && m === "POST") return json({});
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const writes = () => hits.filter((h) => h.method !== "GET" && !/token$|connections$/.test(h.path));
const paid = () => hits.filter((h) => /\/Payments$/.test(h.path) && h.method === "POST");
const mailed = () => hits.filter((h) => /\/Email$/.test(h.path) && h.method === "POST");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron can read and note in Xero; a payment or an email is only ever queued", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createPayment", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.emailInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.getInvoices", summary: "x" }), /not a live operation/);
});

test("the SDK gate still blocks the notes when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  await assert.rejects(check(context(WF, S, new MemoryStore(), NOW, () => {})), WriteBlocked);
  assert.equal(writes().length, 0);
});

test("check: flags the bill with no account code or source document, notes both, and checks nothing twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await check(ctx), { checked: 2, flagged: 1 });
  assert.equal((await store.get<any>("checks", BILL_A)).verdict, "passed");
  const b = await store.get<any>("checks", BILL_B);
  assert.equal(b.verdict, "needs-review");
  assert.ok(b.reasons.some((r: string) => /no account code/.test(r)));
  assert.ok(b.reasons.some((r: string) => /no source document/.test(r)));
  assert.equal(writes().filter((h) => /\/History$/.test(h.path)).length, 2, "one note per checked invoice");
  assert.equal(paid().length + mailed().length, 0, "a check never pays or emails");
  assert.deepEqual(await check(ctx), { checked: 0, flagged: 0 }, "an unchanged invoice is not checked again");
});

test("check: a flagged bill that is then coded and given its source document is checked again and passes", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await check(ctx);
  assert.equal((await store.get<any>("checks", BILL_B)).verdict, "needs-review");
  invoices[BILL_B].LineItems[0].AccountCode = "400";
  attachments[BILL_B] = 1;
  assert.deepEqual(await check(ctx), { checked: 1, flagged: 0 }, "only the fixed bill is checked again");
  assert.equal((await store.get<any>("checks", BILL_B)).verdict, "passed");
});

test("payments: a passed bill due within two days is queued once; approval pays it; nothing is paid by a cron", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await check(ctx);
  assert.deepEqual(await payments(ctx), { queued: 1 });   // BILL_A falls due 2026-11-10; BILL_B never passed
  assert.deepEqual(await payments(ctx), { queued: 1 });   // the same bill again: still one approval
  assert.equal(paid().length, 0, "nothing paid by a cron");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1, "re-runs never queue twice");
  assert.equal(approvals[0].acts[0].op, "accounting.createPayment");
  const ap = await approve(WF, store, approvals[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.deepEqual(paid()[0].body, { Invoice: { InvoiceID: BILL_A }, Account: { Code: "090" }, Date: "2026-11-09", Amount: 220, Reference: "INV-9001" });
  await assert.rejects(approve(WF, store, approvals[0].id, "owner", NOW), /already done/);
});

test("payments park until bank_account_code is set", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S, bank_account_code: "" }, store, NOW, () => {});
  await check(ctx);
  assert.deepEqual(await payments(ctx), { queued: 0, reason: "set bank_account_code in settings" });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("chase: one reminder a day, queued for approval; the customer is emailed only once approved; the next step waits for its day", async () => {
  const store = new MemoryStore();
  const run = (at: Date) => chase(context(WF, S, store, at, () => {}));
  assert.deepEqual(await run(NOW), { queued: 1 });   // 15 days overdue, first step is 7
  assert.deepEqual(await run(NOW), { queued: 0 }, "same day, same reminder: nothing new");
  assert.equal(mailed().length, 0, "nothing emailed by a cron");
  const [first] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(first.acts[0].op, "accounting.emailInvoice");
  await approve(WF, store, first.id, "owner", NOW);
  assert.equal(mailed().length, 1);
  assert.deepEqual(await run(new Date(NOW.getTime() + DAY)), { queued: 1 }, "next day, second step (14 days) is due");
  assert.deepEqual(await run(new Date(NOW.getTime() + 2 * DAY)), { queued: 0 }, "no third step is set");
});

test("payments: a bill whose amount changed after it was queued is rejected and nothing is paid; the next run queues it for the new amount", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await check(ctx);
  assert.deepEqual(await payments(ctx), { queued: 1 });
  invoices[BILL_A].AmountDue = 100;   // part paid after it was queued
  const [first] = Object.values(await store.list<Approval>("approvals"));
  const after = await approve(WF, store, first.id, "owner", NOW);
  assert.equal(after.status, "rejected");
  assert.equal(after.decided_by, "check");
  assert.match(after.error ?? "", /changed after this was queued .*nothing was sent/);
  assert.equal(paid().length, 0, "nothing paid");
  assert.deepEqual(await payments(ctx), { queued: 1 }, "queued again, for 100");
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1, "one fresh approval, alongside the rejected one");
  assert.equal(pending[0].acts[0].input?.body?.Amount, 100);
  assert.equal((await approve(WF, store, pending[0].id, "owner", NOW)).status, "done");
  assert.equal(paid().length, 1);
  assert.equal(paid()[0].body.Amount, 100);
});

test("chase: a reminder whose invoice changed after it was queued is rejected and not emailed; the next run queues it again for the amount now owed", async () => {
  const store = new MemoryStore();
  const run = (at: Date) => chase(context(WF, S, store, at, () => {}));
  assert.deepEqual(await run(NOW), { queued: 1 });
  invoices[SALE_C].AmountDue = 200;   // part paid after it was queued
  const [first] = Object.values(await store.list<Approval>("approvals"));
  assert.equal((await approve(WF, store, first.id, "owner", NOW)).status, "rejected");
  assert.equal(mailed().length, 0, "nothing emailed");
  assert.deepEqual(await run(NOW), { queued: 1 }, "queued again the same day, for 200");
  assert.deepEqual(await run(NOW), { queued: 0 }, "and not again");
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal((await approve(WF, store, pending[0].id, "owner", NOW)).status, "done");
  assert.equal(mailed().length, 1);
});
