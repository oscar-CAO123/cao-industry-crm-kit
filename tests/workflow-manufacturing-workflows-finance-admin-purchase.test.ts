// Manufacturing purchase workflow tests. Xero runs through a fake network. Unleashed request signing is not built, so its
// calls are stubbed at the draft boundary (the allowlist still applies). No test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval, type Act } from "../core/workflows/runtime.ts";
import { reorder, place, bill, CRONS } from "../industries/manufacturing/workflows/finance-admin/purchase/index.ts";
import { render, TARGETS } from "../tools/deploy.ts";
import fs from "node:fs";

const FOLDER = "industries/manufacturing/workflows/finance-admin/purchase";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const S: any = { warehouse_code: "MAIN", reorder_levels: [{ productCode: "OAK-19", minQty: 20, orderQty: 60 }], delivery_days: 14, bill_account_code: "" };
const NOW = new Date("2026-11-09T00:00:00Z");
const PO = "11111111-2222-4333-8444-555555555555", CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef";

type Hit = { host: string; method: string; path: string; body: any; headers: Record<string, string> };
let hits: Hit[] = [];
let unl = { stock: [] as any[], products: [] as any[], orders: [] as any[] };
let unlDrafts: Act[] = [];
let posted: any[] = [];

function fakeXero() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ host: u.host, method: m, path: p, body, headers: init?.headers ?? {} });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Contacts") && m === "GET") return json({ Contacts: [] });
      if (p.endsWith("/Contacts")) return json({ Contacts: [{ ContactID: CID, Name: body?.Contacts?.[0]?.Name }] });
      if (p.endsWith("/Invoices")) return json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT" }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

/** Unleashed reads and the draft order come from these stubs. Any other Unleashed op fails the test. */
function ctxFor(store: MemoryStore) {
  const base = context(WF, S, store, NOW, () => {});
  return {
    ...base,
    draft: async (a: Act) => {
      if (a.platform !== "unleashed") return base.draft(a);
      if (!(WF.draft_ops.unleashed ?? []).includes(a.op)) throw new Error(`not a draft operation: ${a.op}`);
      unlDrafts.push(a);
      if (a.op === "docs.get_StockOnHand") return { data: { Items: unl.stock } } as any;
      if (a.op === "docs.get_Products") return { data: { Items: unl.products } } as any;
      if (a.op === "docs.get_PurchaseOrders") return { data: { Items: unl.orders } } as any;
      if (a.op === "docs.post_PurchaseOrders") { posted.push(a.input?.body); return { data: { Guid: PO, OrderNumber: "PO-00042" } } as any; }
      throw new Error(`unexpected ${a.op}`);
    },
  } as any;
}

const OAK = { ProductCode: "OAK-19", SupplierCode: "BERRY", SupplierName: "Berry Timber", DefaultPurchasePrice: 42.5 };

beforeEach(() => {
  fakeXero(); setTokenStore(new MemoryTokenStore());
  unl = { stock: [], products: [], orders: [] }; unlDrafts = []; posted = [];
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation as a draft, nor a draft operation as a queue", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "unleashed", op: "docs.put_PurchaseOrders_orderGuid", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "unleashed", op: "docs.post_PurchaseOrders", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a draft operation/);
});

test("reorder: a product under its minimum gets one Parked order, once, at the supplier's price", async () => {
  unl.stock = [{ ProductCode: "OAK-19", AvailableQty: 5 }];
  unl.products = [OAK];
  const store = new MemoryStore();
  assert.deepEqual(await reorder(ctxFor(store)), { drafted: 1, skipped: 0 });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].OrderStatus, "Parked");
  assert.equal(posted[0].Supplier.SupplierCode, "BERRY");
  assert.deepEqual(posted[0].PurchaseOrderLines, [{ LineNumber: 1, Product: { ProductCode: "OAK-19" }, OrderQuantity: 60, UnitPrice: 42.5 }]);
  assert.deepEqual(await reorder(ctxFor(store)), { drafted: 0, skipped: 1 }, "an open order is not raised again");
  assert.equal(posted.length, 1);
  assert.ok(unlDrafts.every((a) => !a.op.startsWith("docs.put")), "reorder never places an order");
});

test("place: a parked order is queued for a person to place, once, and the cron never places it", async () => {
  unl.stock = [{ ProductCode: "OAK-19", AvailableQty: 5 }];
  unl.products = [OAK];
  const store = new MemoryStore();
  await reorder(ctxFor(store));
  await place(ctxFor(store));
  await place(ctxFor(store));
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1, "re-runs never queue twice");
  const act = aps[0].acts[0] as any;
  assert.equal(act.op, "docs.put_PurchaseOrders_orderGuid");
  assert.equal(act.input.body.OrderStatus, "Placed");
  assert.equal(act.input.body.Guid, PO);
  assert.equal(act.input.params.orderGuid, PO);
  assert.match(aps[0].summary, /Place PO PO-00042 with Berry Timber/);
  assert.equal(unlDrafts.filter((a) => a.op.startsWith("docs.put")).length, 0);
});

test("approval: a placement does not run while Unleashed signing is not built (fails closed, nothing sent)", async () => {
  unl.stock = [{ ProductCode: "OAK-19", AvailableQty: 5 }];
  unl.products = [OAK];
  const store = new MemoryStore();
  await reorder(ctxFor(store));
  await place(ctxFor(store));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  let outcome: any;
  try { outcome = await approve(WF, store, ap.id, "owner", NOW); } catch (e) { outcome = e; }
  assert.notEqual(outcome?.status, "done");
  assert.equal(hits.filter((h) => h.host.includes("unleashed")).length, 0, "no request reaches Unleashed");
});

test("bill: a receipted order becomes one Xero DRAFT supplier bill, with an idempotency key, never authorised", async () => {
  const store = new MemoryStore();
  await store.put("orders", "OAK-19", { product_code: "OAK-19", status: "parked", created: NOW.toISOString(), supplier_code: "BERRY",
    supplier_name: "Berry Timber", guid: PO, number: "PO-00042", body: {}, total_ex_gst: 2550 } satisfies Order);
  unl.orders = [{ Guid: PO, OrderNumber: "PO-00042", OrderStatus: "Receipted",
    PurchaseOrderLines: [{ Product: { ProductCode: "OAK-19", ProductDescription: "Oak 19mm" }, OrderQuantity: 60, ReceiptQuantity: 60, UnitPrice: 42.5 }] }];
  assert.deepEqual(await bill(ctxFor(store)), { billed: 1 });
  const inv = hits.find((h) => h.path.endsWith("/Invoices") && h.method === "PUT")!;
  const b = inv.body.Invoices[0];
  assert.equal(b.Type, "ACCPAY");
  assert.equal(b.Status, "DRAFT");
  assert.equal(b.Contact.ContactID, CID);
  assert.deepEqual(b.LineItems, [{ Description: "OAK-19 Oak 19mm", Quantity: 60, UnitAmount: 42.5 }]);
  assert.ok(Object.keys(inv.headers).some((k) => k.toLowerCase() === "idempotency-key"));
  assert.equal(hits.filter((h) => JSON.stringify(h.body ?? "").includes("AUTHORISED")).length, 0, "never authorised");
  assert.deepEqual(await bill(ctxFor(store)), { billed: 0 });
  assert.equal(hits.filter((h) => h.path.endsWith("/Invoices") && h.method === "PUT").length, 1, "re-runs never bill twice");
});

test("bill: an order Unleashed shows as Placed is marked placed and bills nothing", async () => {
  const store = new MemoryStore();
  await store.put("orders", "OAK-19", { product_code: "OAK-19", status: "parked", created: NOW.toISOString(), supplier_code: "BERRY",
    supplier_name: "Berry Timber", guid: PO, number: "PO-00042", body: {}, total_ex_gst: 2550 } satisfies Order);
  unl.orders = [{ Guid: PO, OrderNumber: "PO-00042", OrderStatus: "Placed", PurchaseOrderLines: [] }];
  assert.deepEqual(await bill(ctxFor(store)), { billed: 0 });
  assert.equal((await store.get<Order>("orders", "OAK-19"))!.status, "placed");
  assert.equal(hits.filter((h) => h.path.endsWith("/Invoices")).length, 0);
});

test("the crons, allowlists and mapped operations line up", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["bill", "place", "reorder"]);
  for (const c of WF.crons) assert.ok(CRONS[c.entry], `${c.entry} has an implementation`);
  for (const list of [WF.draft_ops, WF.live_ops]) {
    for (const [p, names] of Object.entries(list)) {
      const ops = JSON.parse(fs.readFileSync(`core/sdk/platforms/${p}/ops.json`, "utf8")) as { id: string }[];
      for (const op of names) assert.ok(ops.some((o) => o.id === op), `${p} ${op} is mapped`);
    }
  }
});

test("deploy: every target renders every cron, with key names and no key values", () => {
  for (const t of TARGETS) {
    const files = render(FOLDER, S, t);
    const all = Object.values(files).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    assert.ok(!/tok-|Bearer [A-Za-z0-9]{8}/.test(all), `${t} carries no key values`);
  }
});
