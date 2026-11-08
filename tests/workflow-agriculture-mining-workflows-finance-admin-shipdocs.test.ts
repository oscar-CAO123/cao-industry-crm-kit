// Export document check tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/agriculture-mining/workflows/finance-admin/shipdocs/index.ts";
import type { Shipment } from "../industries/agriculture-mining/workflows/finance-admin/shipdocs/types.ts";
import fs from "node:fs";

const WF_PATH = "industries/agriculture-mining/workflows/finance-admin/shipdocs";
const WF = JSON.parse(fs.readFileSync(`${WF_PATH}/workflow.json`, "utf8")) as WorkflowRecord;
const S: any = { business_name: "Test Agri Exports", invoice_due_days: 30 };
const NOW = new Date("2026-11-09T00:00:00Z");
const INV = "abcdefab-cdef-4abc-8def-abcdefabcdef", CID = "87654321-4321-4321-8321-210987654321";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let inv: any = null;

function fake() {
  hits = []; inv = null;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Contacts") && m === "GET") return json({ Contacts: [{ ContactID: CID, EmailAddress: "buyer@example.com" }] });
      if (p.endsWith("/Contacts")) return json({ Contacts: [{ ContactID: CID }] });
      if (p.endsWith("/Invoices") && m === "PUT") {
        const src = body.Invoices[0];
        inv = { InvoiceID: INV, Status: src.Status, Type: src.Type, LineItems: src.LineItems.map((l: any) => ({ ...l, LineAmount: l.Quantity * l.UnitAmount })),
                Total: src.LineItems.reduce((a: number, l: any) => a + l.Quantity * l.UnitAmount, 0) };
        return json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT" }] });
      }
      if (p.endsWith(`/Invoices/${INV}/Email`)) return new Response(null, { status: 204 });
      if (p.endsWith(`/Invoices/${INV}`) && m === "POST") { inv.Status = body.Invoices[0].Status; return json({ Invoices: [{ InvoiceID: INV, Status: inv.Status }] }); }
      if (p.endsWith(`/Invoices/${INV}`)) return json({ Invoices: [inv] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
// Live steps: an authorise (POST to the invoice) or an email. Nothing in a cron run may produce one.
const liveHits = () => hits.filter((h) => h.path.endsWith(`/Invoices/${INV}/Email`) || (h.path.endsWith(`/Invoices/${INV}`) && h.method === "POST"));

const LINES = [{ description: "Peaches, 2 pallets, lot P-22", qty: 2, unitPrice: 4800 }, { description: "Packing, per pallet", qty: 2, unitPrice: 75 }];
const ship = (over: Partial<Shipment> = {}): Shipment => ({ id: "ship-001", title: "Stone fruit, 2 pallets to Singapore",
  buyer: { name: "Example Buyer Pty Ltd", email: "buyer@example.com" }, lines: LINES, status: "new", ...over });

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.emailInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.deleteInvoice", summary: "x" }), /not a live operation/);
});

test("a shipment with no usable lines waits for details and nothing reaches Xero", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("shipments", "ship-001", ship({ lines: [] }));
  assert.deepEqual(await CRONS.draft(ctx), { drafted: 0, waiting: 1 });
  assert.equal(hits.length, 0);
  assert.equal((await store.get<Shipment>("shipments", "ship-001"))!.status, "needs-details");
});

test("draft: a DRAFT sales invoice in Xero, nothing authorised or emailed", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("shipments", "ship-001", ship());
  assert.deepEqual(await CRONS.draft(ctx), { drafted: 1, waiting: 0 });
  const create = hits.find((h) => h.path.endsWith("/Invoices") && h.method === "PUT")!.body.Invoices[0];
  assert.equal(create.Status, "DRAFT");
  assert.equal(create.Type, "ACCREC");
  assert.equal(create.LineItems.length, 2);
  assert.equal(liveHits().length, 0);
  const saved = (await store.get<Shipment>("shipments", "ship-001"))!;
  assert.equal(saved.status, "drafted");
  assert.equal(saved.invoice_id, INV);
});

test("cross-check passes a matching invoice and flags a changed quantity", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("shipments", "ship-001", ship());
  await CRONS.draft(ctx);
  assert.deepEqual(await CRONS["cross-check"](ctx), { ok: 1, flagged: 0 });
  assert.equal((await store.get<Shipment>("shipments", "ship-001"))!.status, "checked");
  inv.LineItems[0].Quantity = 3; inv.Total = 3 * 4800 + 150;
  assert.deepEqual(await CRONS["cross-check"](ctx), { ok: 0, flagged: 1 });
  const flagged = (await store.get<Shipment>("shipments", "ship-001"))!;
  assert.equal(flagged.status, "mismatch");
  assert.match(flagged.reason!, /line 1/);
  assert.equal(liveHits().length, 0, "a cross-check never changes Xero");
});

test("send: an approved, checked shipment is only queued; the authorise and email run after a person approves", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("shipments", "ship-001", ship());
  await CRONS.draft(ctx); await CRONS["cross-check"](ctx);
  await store.put("shipments", "ship-001", { ...(await store.get<Shipment>("shipments", "ship-001"))!, status: "approved", approved_by: "owner" });
  assert.deepEqual(await CRONS.send(ctx), { queued: 1 });
  assert.equal(liveHits().length, 0, "nothing authorised or emailed by a cron");
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.workflow === WF.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.deepEqual(liveHits().map((h) => h.method + " " + h.path.split("/").pop()), ["POST " + INV, "POST Email"]);
  assert.equal(inv.Status, "AUTHORISED");
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("re-runs never queue the same send twice, and an unchecked shipment is never queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("shipments", "ship-001", ship({ status: "approved", invoice_id: INV, checked_at: NOW.toISOString() }));
  await CRONS.send(ctx); await CRONS.send(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
  await store.put("shipments", "ship-002", ship({ id: "ship-002", status: "approved", invoice_id: INV, checked_at: undefined }));
  await CRONS.send(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "no check, no queue");
});

test("a shipment with no valid buyer email is not queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("shipments", "ship-001", ship({ status: "approved", invoice_id: INV, checked_at: NOW.toISOString(), buyer: { name: "No email" } }));
  assert.deepEqual(await CRONS.send(ctx), { queued: 0 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.match((await store.get<Shipment>("shipments", "ship-001"))!.reason!, /buyer email/);
});
