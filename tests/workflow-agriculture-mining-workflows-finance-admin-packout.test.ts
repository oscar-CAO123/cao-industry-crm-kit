// Grower statements workflow tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { statement, reconcile } from "../industries/agriculture-mining/workflows/finance-admin/packout/index.ts";
import fs from "node:fs";

const DIR = "industries/agriculture-mining/workflows/finance-admin/packout";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Packhouse", bank_account_code: "090" };
const CONTACT = "11111111-2222-4333-8444-555555555555", BILL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", PAY = "99999999-8888-4777-8666-555555555555";
const NOW = new Date("2026-11-09T00:00:00Z");
const PKEY = "grower-a-2026-10-31";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let billStatus = "AUTHORISED", billType = "ACCPAY", amountDue = 1000;

function fake() {
  hits = []; billStatus = "AUTHORISED"; billType = "ACCPAY"; amountDue = 1000;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith(`/Invoices/${BILL}`) && m === "GET")
        return json({ Invoices: [{ InvoiceID: BILL, InvoiceNumber: "GROW-1", Type: billType, Status: billStatus, AmountDue: amountDue }] });
      if (p.endsWith("/Payments") && m === "POST") { billStatus = "PAID"; amountDue = 0; return json({ Payments: [{ PaymentID: PAY, Status: "AUTHORISED" }] }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const payments = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/Payments"));
const pack = (over: Record<string, unknown> = {}) => ({
  key: PKEY, grower: "Orchard Co", xero_contact_id: CONTACT, bill_invoice_id: BILL, period_end: "2026-10-31",
  gross: 800, charges: [{ label: "packing", amount: 120 }, { label: "freight", amount: 80 }], status: "new", ...over,
});

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run the payment as a draft, and cannot queue the bill read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createPayment", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.getInvoice", summary: "x" }), /not a live operation/);
});

test("statement cron checks the bill, drafts the statement and queues the payment, never paying", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  assert.deepEqual(await statement(ctx), { queued: 1, held: 0 });
  assert.equal(payments().length, 0, "nothing paid by a cron");
  const ap = await store.get<Approval>("approvals", approvalId(WF.id, `pay:${PKEY}`));
  assert.equal(ap?.status, "pending");
  assert.equal(ap?.acts[0].op, "accounting.createPayment");
  assert.deepEqual(ap?.acts[0].input?.body, { Invoice: { InvoiceID: BILL }, Account: { Code: "090" }, Date: "2026-11-09", Amount: 600, Reference: "Grower 2026-10-31" });
  const p = await store.get<any>("packouts", PKEY);
  assert.equal(p.status, "queued");
  assert.equal(p.statement.net, 600);
});

test("re-runs never queue the same payment twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  await statement(ctx);
  await store.put("packouts", PKEY, pack()); // the record is reset to new, as if the write after queuing was lost
  await statement(ctx);
  const all = Object.values(await store.list<Approval>("approvals"));
  assert.equal(all.length, 1);
});

test("an approved payment is made once, and reconcile marks the grower paid", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  await statement(ctx);
  const ap = await approve(WF, store, approvalId(WF.id, `pay:${PKEY}`), "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(payments().length, 1);
  assert.equal(payments()[0].body.Amount, 600);
  assert.deepEqual(await reconcile(ctx), { paid: 1 });
  assert.equal((await store.get<any>("packouts", PKEY)).status, "paid");
});

test("a pack-out is held, not queued, when Xero owes less than the net", async () => {
  amountDue = 100;
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  assert.deepEqual(await statement(ctx), { queued: 0, held: 1 });
  assert.equal((await store.get<any>("packouts", PKEY)).status, "held");
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("a bill that is not a supplier bill is held", async () => {
  billType = "ACCREC";
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  assert.deepEqual(await statement(ctx), { queued: 0, held: 1 });
  assert.match((await store.get<any>("packouts", PKEY)).reason, /not a supplier bill/);
});

test("a bad id is held before any call reaches Xero", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack({ bill_invoice_id: "not-a-guid' OR 1=1" }));
  assert.deepEqual(await statement(ctx), { queued: 0, held: 1 });
  assert.equal(hits.length, 0);
});

test("a rejected payment holds the pack-out and nothing is paid", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  await statement(ctx);
  await store.put("approvals", approvalId(WF.id, `pay:${PKEY}`), { ...(await store.get<Approval>("approvals", approvalId(WF.id, `pay:${PKEY}`)))!, status: "rejected" });
  await reconcile(ctx);
  assert.equal((await store.get<any>("packouts", PKEY)).status, "held");
  assert.equal(payments().length, 0);
});

const PKEY_B = "grower-b-2026-10-31";

test("two pack-outs on one bill cannot queue more than Xero owes between them", async () => {
  amountDue = 1000;                                                  // each net is 600: together 1200
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  await store.put("packouts", PKEY_B, pack({ key: PKEY_B, grower: "Orchard Two" }));
  assert.deepEqual(await statement(ctx), { queued: 1, held: 1 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "only one payment is queued");
  const b = await store.get<any>("packouts", PKEY_B);
  assert.equal(b.status, "held");
  assert.match(b.reason, /already queued against this bill/);
});

test("two pack-outs on one bill are both queued when Xero owes enough for both", async () => {
  amountDue = 1500;
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  await store.put("packouts", PKEY_B, pack({ key: PKEY_B, grower: "Orchard Two" }));
  assert.deepEqual(await statement(ctx), { queued: 2, held: 0 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 2);
});

test("a rejected payment does not count against the next pack-out on the same bill", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("packouts", PKEY, pack());
  await statement(ctx);
  await store.put("approvals", approvalId(WF.id, `pay:${PKEY}`), { ...(await store.get<Approval>("approvals", approvalId(WF.id, `pay:${PKEY}`)))!, status: "rejected" });
  await store.put("packouts", PKEY_B, pack({ key: PKEY_B, grower: "Orchard Two" }));
  assert.deepEqual(await statement(ctx), { queued: 1, held: 0 });
});
