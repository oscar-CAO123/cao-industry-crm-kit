// Reconciliation workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pull, match } from "../industries/all/workflows/finance-admin/reconciliation/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/finance-admin/reconciliation/workflow.json", "utf8")) as WorkflowRecord;
const ACC = "11111111-2222-4333-8444-555555555555";
const B_RECEIPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";  // RECEIVE 500.00, reference names INV-0042
const B_DEPOSIT = "99999999-8888-4777-8666-555555555555";  // RECEIVE 1234.56, the Stripe payout's deposit
const B_SPEND = "12345678-1234-4234-8234-123456789012";    // SPEND 40.00, nothing to match
const INV = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const NOW = new Date("2026-11-08T00:00:00Z");
const SETTINGS: any = { bank_accounts: [ACC], processor: "stripe", lookback_days: 60, match_window_days: 3 };
const PAYOUT_UNIX = Math.floor(Date.UTC(2026, 10, 4, 10) / 1000);

let hits: { method: string; path: string; body: any; query: string }[] = [];
let bankRows: any[] = [];
let stripeRows: any[] = [];
let invoices: any[] = [];

const GOOD_BANK = () => [
  { BankTransactionID: B_RECEIPT, Type: "RECEIVE", Total: 500, Date: "2026-11-06T00:00:00", Reference: "INV-0042 Smith", IsReconciled: false, Status: "AUTHORISED" },
  { BankTransactionID: B_DEPOSIT, Type: "RECEIVE", Total: 1234.56, Date: `/Date(${Date.UTC(2026, 10, 5)}+0000)/`, Reference: "Stripe payout", IsReconciled: false, Status: "AUTHORISED" },
  { BankTransactionID: B_SPEND, Type: "SPEND", Total: 40, Date: "2026-11-05T00:00:00", Reference: "Office supplies", IsReconciled: false, Status: "AUTHORISED" },
];
const GOOD_STRIPE = () => [
  { id: "txn_1", object: "balance_transaction", type: "payout", amount: -123456, currency: "aud", created: PAYOUT_UNIX, source: "po_1ABC" },
  { id: "txn_2", object: "balance_transaction", type: "charge", amount: 5000, currency: "aud", created: PAYOUT_UNIX, source: "ch_1" },
];
const GOOD_INVOICES = () => [{ InvoiceID: INV, InvoiceNumber: "INV-0042", Type: "ACCREC", Status: "AUTHORISED", AmountDue: 500 }];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, query: u.search });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Xero
      if (p.endsWith("/BankTransactions") && m === "GET") return json({ BankTransactions: bankRows });
      if (/\/BankTransactions\/[^/]+\/History$/.test(p) && m === "PUT") return json({ HistoryRecords: [{ Details: "noted" }] });
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: invoices });
      if (p.endsWith("/Payments") && m === "POST") return json({ Payments: [{ PaymentID: "PAY1" }] });
      // Stripe
      if (p === "/v1/balance_transactions" && m === "GET") return json({ object: "list", data: stripeRows, has_more: false });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  bankRows = GOOD_BANK(); stripeRows = GOOD_STRIPE(); invoices = GOOD_INVOICES();
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1",
    STRIPE_SECRET_KEY: "fake-test-value", KIT_ALLOW_WRITES: "1" });
});

const writes = (path: RegExp) => hits.filter((h) => h.method !== "GET" && path.test(h.path));
const approvalsOf = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));

test("pull reads only: bank lines and payouts go to the store, nothing is written", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await pull(context(WF, SETTINGS, store, NOW, () => {})), { bank_lines: 3, payouts: 1 });
  assert.ok(hits.filter((h) => !/token$/.test(h.path)).every((h) => h.method === "GET"), "a pull sends no write (token refresh aside)");
  assert.equal(Object.keys(await store.list("payouts")).length, 1, "only the payout is kept, not the charge");
  assert.match(hits.find((h) => h.path.endsWith("/BankTransactions"))!.query, /BankAccount\.AccountID/);
});

test("match drafts a note, queues the receipt payment for approval, and no cron sends a payment", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await pull(ctx());
  assert.deepEqual(await match(ctx()), { noted: 1, queued: 1, worklist: 1 });
  assert.equal(writes(/\/Payments$/).length, 0, "a cron never applies a payment");
  const note = writes(/\/History$/);
  assert.equal(note.length, 1, "one internal note, on the deposit");
  assert.ok(note[0].path.includes(B_DEPOSIT));
  const [ap] = await approvalsOf(store);
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["accounting.createPayment"]);
  const wl = (await store.get<any>("worklist", "latest")).items;
  assert.deepEqual(wl.map((i: any) => i.reason), ["unmatched payment"], "the spend line is left for a person");
});

test("a second run never notes or queues twice; approval runs the payment once", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await pull(ctx()); await match(ctx());
  await pull(ctx()); await match(ctx());
  assert.equal(writes(/\/History$/).length, 1, "the note is written once");
  const aps = await approvalsOf(store);
  assert.equal(aps.length, 1, "re-runs never queue the same payment twice");
  const ap = await approve(WF, store, aps[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  const pay = writes(/\/Payments$/);
  assert.equal(pay.length, 1);
  assert.equal(pay[0].body.Invoice.InvoiceID, INV);
  assert.equal(pay[0].body.Account.AccountID, ACC);
  assert.equal(pay[0].body.Amount, 500);
  assert.equal(pay[0].body.Date, "2026-11-06");
  await assert.rejects(approve(WF, store, aps[0].id, "owner", NOW), /already done/);
});

test("a payout with no deposit and a receipt with no invoice number both go to the worklist", async () => {
  bankRows = [{ BankTransactionID: B_RECEIPT, Type: "RECEIVE", Total: 500, Date: "2026-11-06T00:00:00", Reference: "hello", IsReconciled: false, Status: "AUTHORISED" }];
  stripeRows = [{ id: "txn_1", type: "payout", amount: -99999, currency: "aud", created: PAYOUT_UNIX, source: "po_9ZZZ" }];
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await pull(ctx());
  assert.deepEqual(await match(ctx()), { noted: 0, queued: 0, worklist: 2 });
  const reasons = (await store.get<any>("worklist", "latest")).items.map((i: any) => `${i.kind}:${i.reason}`).sort();
  assert.deepEqual(reasons, ["bank:no invoice number in the reference", "payout:no bank deposit with this amount in the window"]);
  assert.equal(writes(/\/Payments$/).length, 0);
});

test("a receipt whose amount differs from the invoice is never queued", async () => {
  invoices = [{ InvoiceID: INV, InvoiceNumber: "INV-0042", Type: "ACCREC", Status: "AUTHORISED", AmountDue: 450 }];
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await pull(ctx());
  await match(ctx());
  assert.equal((await approvalsOf(store)).length, 0);
  const wl = (await store.get<any>("worklist", "latest")).items;
  assert.ok(wl.some((i: any) => i.id === B_RECEIPT && /amount differs/.test(i.reason)));
});

test("a draft call cannot run a live operation, and a queue cannot take a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createPayment", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.getBankTransactions", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.deleteBankTransaction", summary: "x" }), /not a draft operation/);
});
