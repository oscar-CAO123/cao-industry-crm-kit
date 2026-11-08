// Transport invoices workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { draft, reconcile, chase } from "../industries/transport/workflows/finance-admin/invoices/index.ts";
import type { Settings, Trip } from "../industries/transport/workflows/finance-admin/invoices/types.ts";

const DIR = "industries/transport/workflows/finance-admin/invoices";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const NOW = new Date("2026-11-09T00:00:00Z");
const S: Settings = { business_name: "Test Transport", due_days: 14, sales_account_code: "200", chase_after_days_past_due: [7, 21] };
const TOTAL = "$2,086.25"; // 42.5 x 18.50 + 2 x 650.00

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let created = 0, invStatus = "DRAFT", amountDue = 0, sent = false;

function fake() {
  hits = []; created = 0; invStatus = "DRAFT"; amountDue = 0; sent = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Items")) return json({ Items: [
        { ItemID: "i1", Code: "CARTAGE-T", Name: "Tipper cartage per tonne", SalesDetails: { UnitPrice: 18.5 } },
        { ItemID: "i2", Code: "HIRE-DAY", Name: "Truck hire per day", SalesDetails: { UnitPrice: 650 } },
      ] });
      if (p.endsWith("/Contacts") && m === "GET") return json({ Contacts: [{ ContactID: CID, EmailAddress: "ops@example.com" }] });
      if (p.endsWith("/Contacts")) return json({ Contacts: [{ ContactID: CID }] });
      if (p.endsWith("/Invoices") && m === "PUT") { created++; return json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT" }] }); }
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: [{ InvoiceID: INV, Status: invStatus, AmountDue: amountDue, DueDate: "2026-11-01T00:00:00", SentToContact: sent }] });
      if (p.endsWith(`/Invoices/${INV}`) && m === "POST") { invStatus = "AUTHORISED"; return json({ Invoices: [{ InvoiceID: INV, Status: "AUTHORISED" }] }); }
      if (p.endsWith(`/Invoices/${INV}/Email`)) { sent = true; return json({}); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const authorises = () => hits.filter((h) => h.method === "POST" && h.path.endsWith(`/Invoices/${INV}`));
const emails = () => hits.filter((h) => h.path.endsWith("/Email"));

const TRIP: Trip = {
  id: "docket-1001", reference: "PO-7781", customer: { name: "Quarry Co", email: "ops@example.com" }, pod: true,
  lines: [{ code: "CARTAGE-T", qty: 42.5 }, { code: "HIRE-DAY", qty: 2 }], status: "new", chased: [], created: NOW.toISOString(),
};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.emailInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a live operation/);
});

test("runtime: the SDK gate still blocks writes when the deploy does not allow them", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore();
  await store.put("trips", TRIP.id, TRIP);
  await assert.rejects(draft(context(WF, S, store, NOW, () => {})), WriteBlocked);
  assert.equal(created, 0);
});

test("draft: a trip with proof of delivery becomes a DRAFT invoice priced from the rate card, and is queued, never sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("trips", TRIP.id, TRIP);
  assert.deepEqual(await draft(ctx), { drafted: 1, parked: 0 });
  const inv = hits.find((h) => h.path.endsWith("/Invoices") && h.method === "PUT")!.body.Invoices[0];
  assert.equal(inv.Status, "DRAFT");
  assert.equal(inv.Reference, "PO-7781");
  assert.deepEqual(inv.LineItems[0], { ItemCode: "CARTAGE-T", Description: "Tipper cartage per tonne", Quantity: 42.5, UnitAmount: 18.5, AccountCode: "200" });
  assert.equal(emails().length + authorises().length, 0, "nothing authorised or emailed by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["accounting.updateInvoice", "accounting.emailInvoice"]);
  assert.ok(ap.summary.includes(TOTAL), ap.summary);
  // A second run finds the trip already drafted: no second invoice, no second approval.
  assert.deepEqual(await draft(context(WF, S, store, NOW, () => {})), { drafted: 0, parked: 0 });
  assert.equal(created, 1);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1);
});

test("approve: authorises, then emails once; a second approve is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("trips", TRIP.id, TRIP);
  await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  assert.equal(authorises().length, 1);
  assert.equal(emails().length, 1);
  assert.equal(hits.findIndex((h) => h.path.endsWith(`/Invoices/${INV}`)) < hits.findIndex((h) => h.path.endsWith("/Email")), true, "authorised before emailed");
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
  assert.equal(emails().length, 1);
});

test("parked trips: no proof of delivery, or a code off the rate card, create nothing and say why", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("trips", "docket-1002", { ...TRIP, id: "docket-1002", pod: false });
  await store.put("trips", "docket-1003", { ...TRIP, id: "docket-1003", lines: [{ code: "NOPE", qty: 1 }] });
  assert.deepEqual(await draft(ctx), { drafted: 0, parked: 2 });
  assert.equal(created, 0);
  const a = await store.get<Trip>("trips", "docket-1002"), b = await store.get<Trip>("trips", "docket-1003");
  assert.equal(a?.status, "needs-check");
  assert.match(a?.reason ?? "", /proof of delivery/);
  assert.match(b?.reason ?? "", /NOPE/);
  // Once the docket is on file, the same trip drafts on the next run.
  await store.put("trips", "docket-1002", { ...a!, pod: true });
  // The off-rate-card trip is still parked on this run, and only the docket now on file drafts.
  assert.deepEqual(await draft(context(WF, S, store, NOW, () => {})), { drafted: 1, parked: 1 });
  assert.equal(created, 1);
});

test("reconcile reads status and amount due from Xero, and marks an invoice paid when nothing is owed", async () => {
  const store = new MemoryStore();
  await store.put("trips", TRIP.id, TRIP);
  await draft(context(WF, S, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  amountDue = 2086.25; sent = true;
  assert.deepEqual(await reconcile(context(WF, S, store, NOW, () => {})), { updated: 1 });
  const t = await store.get<Trip>("trips", TRIP.id);
  assert.equal(t?.status, "authorised");
  assert.equal(t?.amount_due, 2086.25);
  assert.equal(t?.due, "2026-11-01");
  amountDue = 0; invStatus = "PAID";
  await reconcile(context(WF, S, store, NOW, () => {}));
  assert.equal((await store.get<Trip>("trips", TRIP.id))?.status, "paid");
  assert.equal(emails().length, 1, "reconcile sends nothing");
});

test("chase: one reminder per step once past due, queued for approval and never sent by the cron", async () => {
  const store = new MemoryStore();
  await store.put("trips", TRIP.id, TRIP);
  await draft(context(WF, S, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  amountDue = 2086.25; sent = true;
  await reconcile(context(WF, S, store, NOW, () => {}));
  // Due 1 November: 8 days past due on 9 November, so reminder 1 (7 days) is queued.
  assert.deepEqual(await chase(context(WF, S, store, NOW, () => {})), { queued: 1 });
  assert.deepEqual(await chase(context(WF, S, store, NOW, () => {})), { queued: 0 }, "same day, nothing new");
  assert.equal(emails().length, 1, "reminder waits for approval");
  const at21 = new Date("2026-11-22T00:00:00Z");
  assert.deepEqual(await chase(context(WF, S, store, at21, () => {})), { queued: 1 });
  assert.deepEqual(await chase(context(WF, S, store, at21, () => {})), { queued: 0 });
  assert.equal((await store.get<Trip>("trips", TRIP.id))?.chased.length, 2);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 3);
  const reminder = await store.get<Approval>("approvals", approvalId(WF.id, `chase:${INV}:1`));
  assert.equal(reminder?.status, "pending");
});
