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
let stripePaid = false, xeroPaid = false, xeroEmail = "sam@example.com";

function fake() {
  hits = []; stripePaid = false; xeroPaid = false; xeroEmail = "sam@example.com";
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
      if (p.endsWith("/Invoices") && m === "GET" && u.searchParams.get("IDs")) return json({ Invoices: [{ InvoiceID: XID, Status: xeroPaid ? "PAID" : "AUTHORISED", AmountDue: xeroPaid ? 0 : 250 }] });
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: [
        { InvoiceID: XID, InvoiceNumber: "INV-0042", Status: "AUTHORISED", AmountDue: 250, DueDate: "2026-11-01", CurrencyCode: "AUD",
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
  assert.deepEqual(await chase(context(WF, SET, store, day1, () => {})), { queued: 0, skipped: 0 }, "the next step is not due until its day");
  assert.equal(Object.keys(await store.list("approvals")).length, 2, "re-runs never queue twice");
  for (const ap of approvals) assert.equal((await approve(WF, store, ap.id, "owner", day1)).status, "done");
  assert.ok(hits.some((h) => h.method === "POST" && h.path === `/v1/invoices/${SINV}/pay`), "the approved retry ran");
  assert.ok(hits.some((h) => h.method === "POST" && h.path.endsWith(`/Invoices/${XID}/Email`)), "the approved reminder ran");
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
