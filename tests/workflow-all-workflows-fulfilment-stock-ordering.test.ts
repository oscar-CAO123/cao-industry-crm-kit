// Stock-ordering workflow tests. Every request goes to a fake network: no test reaches a real Xero organisation.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { stockCheck, reorderDraft, poCheck } from "../industries/all/workflows/fulfilment/stock-ordering/index.ts";
import { checkRules, type Settings } from "../industries/all/workflows/fulfilment/stock-ordering/types.ts";
import fs from "node:fs";

const WF_PATH = "industries/all/workflows/fulfilment/stock-ordering/workflow.json";
const WF = JSON.parse(fs.readFileSync(WF_PATH, "utf8")) as WorkflowRecord;
const SUPPLIER = "5a4d1f2e-3b4c-4d5e-8f60-718293a4b5c6";
const PO = "11112222-3333-4444-8555-666677778888";
const NOW = new Date("2026-11-08T02:00:00Z");
const NEXT = new Date("2026-11-09T02:00:00Z");
const SETTINGS: Settings = {
  business_name: "Test Stores", delivery_days: 14,
  rules: [
    { code: "SKU-001", min: 20, max: 60, supplier: SUPPLIER },
    { code: "SKU-002", min: 10, max: 40, supplier: SUPPLIER },
    { code: "SKU-009", min: 5, max: 15, supplier: SUPPLIER },
  ],
};

type Hit = { method: string; path: string; body: any; headers: Record<string, string> };
let hits: Hit[] = [];
let onHand = 12, poStatus = "DRAFT";

function fake() {
  hits = []; onHand = 12; poStatus = "DRAFT";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, headers: init?.headers ?? {} });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Items") && m === "GET") return json({ Items: [
        { ItemID: "i1", Code: "SKU-001", Name: "Widget <b>", QuantityOnHand: onHand, PurchaseDetails: { UnitPrice: 8.5 } },
        { ItemID: "i2", Code: "SKU-002", Name: "Bolt", QuantityOnHand: 50, PurchaseDetails: { UnitPrice: 1 } },
      ] });
      if (p.endsWith("/PurchaseOrders") && m === "PUT") return json({ PurchaseOrders: [{ PurchaseOrderID: PO, Status: "DRAFT" }] });
      if (p.endsWith(`/PurchaseOrders/${PO}`) && m === "GET") return json({ PurchaseOrders: [{ PurchaseOrderID: PO, Status: poStatus }] });
      if (p.endsWith(`/PurchaseOrders/${PO}`) && m === "POST") { poStatus = "AUTHORISED"; return json({ PurchaseOrders: [{ PurchaseOrderID: PO, Status: "AUTHORISED" }] }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
// Writes are everything that is not a GET, apart from the sign-in refresh.
const writes = () => hits.filter((h) => h.method !== "GET" && !/\/connect\/token$/.test(h.path));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation, and a purchase order cannot be queued as a draft", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updatePurchaseOrder", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createPurchaseOrders", summary: "x" }), /not a live operation/);
  assert.deepEqual(WF.live_ops, { xero: ["accounting.updatePurchaseOrder"] });
});

test("crons never send: the only write is a DRAFT purchase order, and nothing authorises one", async () => {
  const store = new MemoryStore(), log = () => {};
  await stockCheck(context(WF, SETTINGS, store, NOW, log));
  await reorderDraft(context(WF, SETTINGS, store, NOW, log));
  await poCheck(context(WF, SETTINGS, store, NOW, log));
  assert.equal(writes().length, 1, JSON.stringify(writes()));
  assert.equal(writes()[0].method, "PUT");
  assert.equal(writes()[0].body.PurchaseOrders[0].Status, "DRAFT");
  assert.ok(!hits.some((h) => h.method === "POST" && h.path.includes("/PurchaseOrders/")), "no authorisation was sent");
});

test("stock check stores stock on hand for each ruled item and names the one Xero does not track", async () => {
  const store = new MemoryStore();
  const r: any = await stockCheck(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(r.missing, ["SKU-009"]);
  const s: any = await store.get("stock", "SKU-001");
  assert.equal(s.on_hand, 12);
  assert.equal(s.unit_cost, 8.5);
  assert.equal(s.name, "Widget <b>");                  // stored as Xero sent it; escaping belongs to any page that shows it
  assert.equal(await store.get("stock", "SKU-002").then((x: any) => x.on_hand), 50);
});

test("reorder draft drafts one order for the top-up, queues its authorisation, and leaves it unauthorised", async () => {
  const store = new MemoryStore();
  await stockCheck(context(WF, SETTINGS, store, NOW, () => {}));
  const r: any = await reorderDraft(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(r.drafted, 1);
  const put = writes().find((h) => h.method === "PUT")!;
  assert.equal(put.body.PurchaseOrders[0].Status, "DRAFT");
  assert.equal(put.body.PurchaseOrders[0].Contact.ContactID, SUPPLIER);
  assert.equal(put.body.PurchaseOrders[0].LineItems[0].ItemCode, "SKU-001");
  assert.equal(put.body.PurchaseOrders[0].LineItems[0].Quantity, 48);
  assert.equal(put.body.PurchaseOrders[0].DeliveryDate, "2026-11-22");
  assert.ok(String(put.headers["Idempotency-Key"]).startsWith("po:"), "the create carries an idempotency key");
  const ap = (await store.list<Approval>("approvals"));
  const list = Object.values(ap);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "pending");
  assert.equal(list[0].acts[0].op, "accounting.updatePurchaseOrder");
  assert.equal(list[0].acts[0].input?.body && (list[0].acts[0].input.body as any).PurchaseOrders[0].Status, "AUTHORISED");
});

test("re-runs never double-queue, never draft twice, and an open order covers the item on later days", async () => {
  const store = new MemoryStore();
  const ctx = (d: Date) => context(WF, SETTINGS, store, d, () => {});
  await stockCheck(ctx(NOW)); await reorderDraft(ctx(NOW)); await reorderDraft(ctx(NOW));
  assert.equal(writes().filter((h) => h.method === "PUT").length, 1);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
  await stockCheck(ctx(NEXT)); await reorderDraft(ctx(NEXT));
  assert.equal(writes().filter((h) => h.method === "PUT").length, 1, "the open order still covers SKU-001");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("an approved authorisation is the only act that reaches the supplier, and po-check then reads it", async () => {
  const store = new MemoryStore();
  const ctx = (d: Date) => context(WF, SETTINGS, store, d, () => {});
  await stockCheck(ctx(NOW)); await reorderDraft(ctx(NOW));
  const id = approvalId(WF.id, `authorise:${PO}`);
  const ap = await approve(WF, store, id, "oscar", NOW);
  assert.equal(ap.status, "done");
  assert.ok(hits.some((h) => h.method === "POST" && h.path.endsWith(`/PurchaseOrders/${PO}`) && h.body.PurchaseOrders[0].Status === "AUTHORISED"));
  await poCheck(ctx(NOW));
  const rec: any = Object.values(await store.list("reorders"))[0];
  assert.equal(rec.stage, "authorised");
  assert.equal(rec.overdue, false);
  await poCheck(context(WF, SETTINGS, store, new Date("2026-11-23T02:00:00Z"), () => {}));
  const late: any = Object.values(await store.list("reorders"))[0];
  assert.equal(late.overdue, true, "a purchase order past its delivery date is flagged");
});

test("po-check closes a billed order, so a later low stock drafts a new one", async () => {
  const store = new MemoryStore();
  const ctx = (d: Date) => context(WF, SETTINGS, store, d, () => {});
  await stockCheck(ctx(NOW)); await reorderDraft(ctx(NOW));
  poStatus = "BILLED";
  const c: any = await poCheck(ctx(NEXT));
  assert.equal(c.closed, 1);
  await stockCheck(ctx(NEXT)); await reorderDraft(ctx(NEXT));
  assert.equal(writes().filter((h) => h.method === "PUT").length, 2);
});

test("a bad rule fails before any call is made", async () => {
  assert.throws(() => checkRules({ rules: [{ code: "SKU-001", min: 5, max: 3, supplier: SUPPLIER }] } as Settings), /needs whole numbers/);
  assert.throws(() => checkRules({ rules: [{ code: "SKU 001", min: 1, max: 3, supplier: SUPPLIER }] } as Settings), /not a Xero item code/);
  assert.throws(() => checkRules({ rules: [{ code: "SKU-001", min: 1, max: 3, supplier: "not-a-guid" }] } as Settings), /Xero contact ID/);
  await assert.rejects(stockCheck(context(WF, { rules: [] } as unknown as Settings, new MemoryStore(), NOW, () => {})), /at least one item/);
  assert.equal(hits.length, 0);
});
