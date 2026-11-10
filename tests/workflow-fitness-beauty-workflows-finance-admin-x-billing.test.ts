// Failed-payments workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { detect, reconcile, chase } from "../industries/fitness-beauty/workflows/finance-admin/x-billing/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/fitness-beauty/workflows/finance-admin/x-billing/workflow.json", "utf8")) as WorkflowRecord;
const SINV = "in_1Test12345", XID = "11111111-2222-4333-8444-555555555555", XCID = "87654321-4321-4321-8321-210987654321";
const NOW = new Date("2026-11-08T00:00:00Z");
const SET: any = { sources: ["stripe", "xero"], chase_after_days: [1, 5], retry_stripe: true };

type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];
let stripePaid = false, xeroPaid = false, xeroEmail = "sam@example.com", xeroOwed = 250;

function fake() {
  hits = []; stripePaid = false; xeroPaid = false; xeroEmail = "sam@example.com"; xeroOwed = 250;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Stripe
      if (p === "/v1/invoices" && m === "GET") return json({ object: "list", data: [
        { id: SINV, object: "invoice", number: "A1B2", status: "open", attempted: true, attempt_count: 1, amount_remaining: 4500, currency: "aud", due_date: null, customer_name: "Jo Park", customer_email: "jo@example.com" },
        { id: "in_OK0000000001", object: "invoice", status: "open", attempted: false, amount_remaining: 3000, currency: "aud" },
        { id: "in_bad/../x", object: "invoice", status: "open", attempted: true, amount_remaining: 100, currency: "aud" },
      ] });
      if (p === `/v1/invoices/${SINV}` && m === "GET") return json({ id: SINV, status: stripePaid ? "paid" : "open", amount_remaining: stripePaid ? 0 : 4500 });
      if (p === `/v1/invoices/${SINV}/pay` || p === `/v1/invoices/${SINV}/send`) return json({ id: SINV, status: "paid" });
      // Xero
      if (p.endsWith("/Invoices") && m === "GET" && u.searchParams.get("IDs")) return json({ Invoices: [{ InvoiceID: XID, Status: xeroPaid ? "PAID" : "AUTHORISED", AmountDue: xeroPaid ? 0 : xeroOwed }] });
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: [
        { InvoiceID: XID, InvoiceNumber: "INV-0042", Status: "AUTHORISED", AmountDue: xeroOwed, DueDate: "2026-11-01", CurrencyCode: "AUD",
          Contact: { ContactID: XCID, Name: "Sam Lee", ...(xeroEmail ? { EmailAddress: xeroEmail } : {}) } },
        { InvoiceID: "22222222-3333-4444-8555-666666666666", InvoiceNumber: "INV-0043", Status: "AUTHORISED", AmountDue: 90, DueDate: "2026-11-20", Contact: { ContactID: XCID, Name: "Sam Lee" } },
      ] });
      if (p.endsWith(`/Invoices/${XID}/History`) && m === "PUT") return json({ HistoryRecords: [{ Details: "note" }] });
      if (p.endsWith(`/Invoices/${XID}/Email`) && m === "POST") return new Response(null, { status: 204 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const moneyMoves = () => hits.filter((h) => /\/(pay|send)$/.test(h.path) || /\/Email$/.test(h.path));
const notes = () => hits.filter((h) => h.path.endsWith("/History") && h.method === "PUT");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_fake", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "stripe", op: "openapi_spec3.PostInvoicesInvoicePay", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoiceHistory", summary: "x" }), /not a live operation/);
});

test("detect reads failures and writes one note per failure: no money moves and no email goes out", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await detect(ctx), { added: 2 });
  assert.equal(moneyMoves().length, 0, "nothing paid, retried or emailed by a cron");
  assert.equal(notes().length, 1, "one note in Xero, for the overdue invoice");
  assert.ok(notes()[0].path.endsWith(`/Invoices/${XID}/History`));
  assert.equal(hits.some((h) => h.path.includes("bad")), false, "a malformed Stripe id is never put into a path");
  assert.equal(Object.keys(await store.list("failures")).length, 2);
});

test("detect is idempotent: a second run adds nothing and writes no second note", async () => {
  const store = new MemoryStore();
  await detect(context(WF, SET, store, NOW, () => {}));
  assert.deepEqual(await detect(context(WF, SET, store, NOW, () => {})), { added: 0 });
  assert.equal(notes().length, 1);
});

test("chase queues a Stripe retry and a Xero reminder once each; approval runs them", async () => {
  const store = new MemoryStore();
  await detect(context(WF, SET, store, NOW, () => {}));
  const day1 = new Date(NOW.getTime() + 864e5);
  assert.deepEqual(await chase(context(WF, SET, store, day1, () => {})), { queued: 2, skipped: 0 });
  assert.equal(moneyMoves().length, 0, "queued, not run");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 2);
  assert.deepEqual(approvals.map((a) => a.acts[0].op).sort(), ["accounting.emailInvoice", "openapi_spec3.PostInvoicesInvoicePay"].sort());
  const pay = approvals.find((a) => a.acts[0].op.endsWith("PostInvoicesInvoicePay"))!.acts[0];
  assert.deepEqual(pay.check?.expect.map((e) => e.path), ["status", "amount_remaining"]);
  assert.equal(pay.check?.expect[0].equals, "open");
  assert.ok(Number.isInteger(pay.check?.expect[1].equals), "the amount is in minor units, as Stripe holds it");
  assert.ok(pay.key!.endsWith(`:${pay.check?.expect[1].equals}`), "the key carries the amount, so a changed invoice queues afresh");
  assert.deepEqual(await chase(context(WF, SET, store, day1, () => {})), { queued: 0, skipped: 0 }, "the next step is not due until its day");
  assert.equal(Object.keys(await store.list("approvals")).length, 2, "re-runs never queue twice");
  for (const ap of approvals) assert.equal((await approve(WF, store, ap.id, "owner", day1)).status, "done");
  assert.ok(hits.some((h) => h.method === "POST" && h.path === `/v1/invoices/${SINV}/pay`), "the approved retry ran");
  assert.ok(hits.some((h) => h.method === "POST" && h.path.endsWith(`/Invoices/${XID}/Email`)), "the approved reminder ran");
});

test("a Xero reminder sends once when the invoice is unchanged at approval", async () => {
  const store = new MemoryStore();
  await detect(context(WF, SET, store, NOW, () => {}));
  const day1 = new Date(NOW.getTime() + 864e5);
  await chase(context(WF, SET, store, day1, () => {}));
  const reminder = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].op === "accounting.emailInvoice")!;
  assert.equal(reminder.acts[0].check?.op, "accounting.getInvoices", "the reminder carries a check on the invoice");
  assert.equal((await approve(WF, store, reminder.id, "owner", day1)).status, "done");
  const emails = () => hits.filter((h) => h.method === "POST" && h.path.endsWith(`/Invoices/${XID}/Email`)).length;
  assert.equal(emails(), 1, "the reminder went out once");
  assert.ok(hits.findIndex((h) => h.method === "GET" && h.search.includes("IDs=")) < hits.findIndex((h) => h.path.endsWith("/Email")), "the invoice was read before the send");
  await assert.rejects(approve(WF, store, reminder.id, "owner", day1), /already done/, "a second approval cannot send it again");
  assert.equal(emails(), 1);
});

test("a Xero reminder is not sent when the invoice changed after it was queued; the approval is rejected", async () => {
  const store = new MemoryStore();
  await detect(context(WF, SET, store, NOW, () => {}));
  const day1 = new Date(NOW.getTime() + 864e5);
  await chase(context(WF, SET, store, day1, () => {}));
  xeroOwed = 100; // a part payment after the reminder was queued
  const reminder = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].op === "accounting.emailInvoice")!;
  const ap = await approve(WF, store, reminder.id, "owner", day1);
  assert.equal(ap.status, "rejected");
  assert.equal(ap.decided_by, "check");
  assert.match(String(ap.error), /record changed/);
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/Email")).length, 0, "nothing was emailed");
});

test("a reminder closed by its check is queued again once the invoice is read again, and not before", async () => {
  const store = new MemoryStore();
  await detect(context(WF, SET, store, NOW, () => {}));
  const day1 = new Date(NOW.getTime() + 864e5), day2 = new Date(NOW.getTime() + 2 * 864e5);
  await chase(context(WF, SET, store, day1, () => {}));
  const first = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].op === "accounting.emailInvoice")!;
  xeroOwed = 100;
  await approve(WF, store, first.id, "owner", day1);
  assert.deepEqual(await chase(context(WF, SET, store, day2, () => {})), { queued: 0, skipped: 1 }, "the stored amount is still the old one: nothing new yet");
  assert.deepEqual(await detect(context(WF, SET, store, day2, () => {})), { added: 0 });
  assert.deepEqual(await chase(context(WF, SET, store, day2, () => {})), { queued: 1, skipped: 0 }, "the amount is refreshed, so the step is queued afresh");
  const reminders = Object.values(await store.list<Approval>("approvals")).filter((a) => a.acts[0].op === "accounting.emailInvoice");
  assert.equal(reminders.length, 2);
  const fresh = reminders.find((a) => a.status === "pending")!;
  assert.equal(fresh.acts[0].check?.expect[1].equals, 100);
  assert.equal((await approve(WF, store, fresh.id, "owner", day2)).status, "done");
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith(`/Invoices/${XID}/Email`)).length, 1, "only the current amount was emailed");
});

test("an invoice with no email on file is not queued for a reminder; a person is told", async () => {
  xeroEmail = "";
  const store = new MemoryStore();
  await detect(context(WF, SET, store, NOW, () => {}));
  assert.deepEqual(await chase(context(WF, SET, store, new Date(NOW.getTime() + 864e5), () => {})), { queued: 1, skipped: 1 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).some((a) => a.acts[0].op === "accounting.emailInvoice"), false);
});

test("reconcile closes a paid failure, notes it, and the chase then has nothing to do", async () => {
  const store = new MemoryStore();
  await detect(context(WF, SET, store, NOW, () => {}));
  stripePaid = true; xeroPaid = true;
  const day1 = new Date(NOW.getTime() + 864e5);
  assert.deepEqual(await reconcile(context(WF, SET, store, day1, () => {})), { closed: 2 });
  assert.equal(notes().length, 2, "seen note and resolved note in Xero");
  assert.deepEqual(await chase(context(WF, SET, store, day1, () => {})), { queued: 0, skipped: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("overdue follows Stripe paging: a failed invoice on the second page is still found", async () => {
  const page2 = "in_Page2Invoice01", seen: (string | null)[] = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any) => {
      const u = new URL(String(url));
      if (u.pathname !== "/v1/invoices") return new Response("not faked: " + u.pathname, { status: 404 });
      const after = u.searchParams.get("starting_after");
      seen.push(after);
      const inv = (id: string) => ({ id, object: "invoice", number: id.slice(-4), status: "open", attempted: true, attempt_count: 1,
        amount_remaining: 1000, currency: "aud", customer_name: "Pat Doe", customer_email: "pat@example.com" });
      const body = after === null ? { has_more: true, data: [inv(SINV)] } : { has_more: false, data: [inv(page2)] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as any,
  });
  const store = new MemoryStore();
  assert.deepEqual(await detect(context(WF, { ...SET, sources: ["stripe"] }, store, NOW, () => {})), { added: 2 });
  assert.deepEqual(seen, [null, SINV], "the second page is requested from the last invoice id of the first");
  assert.ok(await store.get("failures", `stripe:${page2}`), "the invoice on page two is recorded");
});
