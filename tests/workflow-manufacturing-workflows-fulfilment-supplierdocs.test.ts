// Supplier documents workflow tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, match, publish } from "../industries/manufacturing/workflows/fulfilment/supplierdocs/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/manufacturing/workflows/fulfilment/supplierdocs/workflow.json", "utf8")) as WorkflowRecord;
const BILL_A = "11111111-2222-4333-8444-555555555555";   // matched to PAPER-A4 at its Xero price
const BILL_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";   // a code Xero does not have
const BILL_C = "99999999-8888-4777-8666-555555555555";   // already AUTHORISED: never read as a draft
const BILL_D = "12345678-1234-4234-8234-123456789012";   // matched code, billed at a changed price
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let itemCost = 10, failAuthorise = 0;

function fake() {
  hits = []; itemCost = 10; failAuthorise = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: [
        { InvoiceID: BILL_A, InvoiceNumber: "INV-100", Type: "ACCPAY", Status: "DRAFT", Total: 220, Date: "2026-11-01T00:00:00",
          Contact: { Name: "Paper Supply Co" }, LineItems: [{ Description: "A4 paper box", ItemCode: "PAPER-A4", Quantity: 2, UnitAmount: 10 }] },
        { InvoiceID: BILL_B, InvoiceNumber: "INV-101", Type: "ACCPAY", Status: "DRAFT", Total: 55, Date: "2026-11-02T00:00:00",
          Contact: { Name: "Ink Works" }, LineItems: [{ Description: "Cyan toner", ItemCode: "TONER-X9", Quantity: 1, UnitAmount: 55 }] },
        { InvoiceID: BILL_C, InvoiceNumber: "INV-099", Type: "ACCPAY", Status: "AUTHORISED", Total: 10, Date: "2026-10-30T00:00:00",
          Contact: { Name: "Paper Supply Co" }, LineItems: [{ Description: "Old", ItemCode: "PAPER-A4", Quantity: 1, UnitAmount: 10 }] },
        { InvoiceID: BILL_D, InvoiceNumber: "INV-102", Type: "ACCPAY", Status: "DRAFT", Total: 13.2, Date: "2026-11-03T00:00:00",
          Contact: { Name: "Paper Supply Co" }, LineItems: [{ Description: "A4 paper box", ItemCode: "PAPER-A4", Quantity: 1, UnitAmount: 12 }] },
      ] });
      if (p.endsWith("/Items") && m === "GET") return json({ Items: [
        { ItemID: "i1", Code: "PAPER-A4", Name: "A4 paper box", PurchaseDetails: { UnitPrice: itemCost } },
        { ItemID: "i2", Code: "NO-PRICE", Name: "Item without a price", PurchaseDetails: {} },
      ] });
      if (p.endsWith(`/Invoices/${BILL_A}`) && m === "POST") {
        if (failAuthorise-- > 0) return new Response("{}", { status: 500 });
        return json({ Invoices: [{ InvoiceID: BILL_A, Status: "AUTHORISED" }] });
      }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET" && !/\/token$/.test(h.path));
const NOW = new Date("2026-11-09T00:00:00Z");
const SETTINGS: any = { business_name: "Test Print", price_tolerance_percent: 2 };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: the authorise step is live, so no cron can draft it", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.getInvoices", summary: "x" }), /not a live operation/);
});

test("intake takes only draft purchase bills, and re-runs add nothing twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 3 });
  assert.equal(await store.get("documents", BILL_C), undefined, "an authorised bill is not a document");
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.equal(writes().length, 0, "intake only reads");
});

test("match: clean lines are matched, unknown codes and changed prices go to a person", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await match(ctx), { matched: 1, needs_review: 2 });
  const a = await store.get<any>("documents", BILL_A);
  assert.equal(a.status, "matched");
  assert.equal(a.lines[0].sku, "PAPER-A4");
  const b = await store.get<any>("documents", BILL_B);
  assert.equal(b.status, "needs-review");
  assert.match(b.reasons[0], /no Xero item for TONER-X9/);
  const d = await store.get<any>("documents", BILL_D);
  assert.equal(d.status, "needs-review");
  assert.match(d.reasons[0], /PAPER-A4 billed at \$12\.00, Xero says \$10\.00/);
  assert.equal(writes().length, 0, "match only reads and records");
});

test("publish queues one authorisation per clean bill, never twice, and never sends one by itself", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await match(ctx);
  assert.deepEqual(await publish(ctx), { queued: 1, authorised: 0, rejected: 0 });
  assert.deepEqual(await publish(ctx), { queued: 0, authorised: 0, rejected: 0 }, "re-runs never queue twice");
  const pending = await store.list<Approval>("approvals");
  assert.equal(Object.keys(pending).length, 1);
  const [ap] = Object.values(pending);
  assert.deepEqual(ap.acts.map((x) => x.op), ["accounting.updateInvoice"]);
  assert.match(ap.summary, /Authorise bill INV-100 from Paper Supply Co/);
  assert.equal(writes().length, 0, "no write reaches Xero before approval");
});

test("approval authorises the bill once; the next publish records it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await match(ctx); await publish(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].path, `/api.xro/2.0/Invoices/${BILL_A}`);
  assert.deepEqual(w[0].body, { Invoices: [{ InvoiceID: BILL_A, Status: "AUTHORISED" }] });
  assert.equal(approvalId(WF.id, `authorise:${BILL_A}`), ap.id);
  assert.deepEqual(await publish(ctx), { queued: 0, authorised: 1, rejected: 0 });
  assert.equal((await store.get<any>("documents", BILL_A)).status, "authorised");
  await approve(WF, store, ap.id, "owner", NOW).catch(() => {});
  assert.equal(writes().length, 1, "approved once, never again");
});

test("a failed authorisation stays queued for a person to retry", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await match(ctx); await publish(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  failAuthorise = 1;
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "failed");
  assert.deepEqual(await publish(ctx), { queued: 0, authorised: 0, rejected: 0 });
  assert.equal((await store.get<any>("documents", BILL_A)).status, "queued");
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
});

test("a rejected authorisation is recorded and the bill is not queued again", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await match(ctx); await publish(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await store.put("approvals", ap.id, { ...ap, status: "rejected", decided: NOW.toISOString() });
  assert.deepEqual(await publish(ctx), { queued: 0, authorised: 0, rejected: 1 });
  await match(ctx);
  assert.equal((await store.get<any>("documents", BILL_A)).status, "rejected");
  assert.deepEqual(await publish(ctx), { queued: 0, authorised: 0, rejected: 0 });
  assert.equal(writes().length, 0);
});
