// Fulfilment run workflow tests. No request reaches Unleashed: the crons run against a fake draft that enforces the same
// draft-op list the runtime uses. Unleashed request signing is not built yet, so an approved shipment is attempted and
// fails with the signer's error; that failure is asserted here, not hidden.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, stockCheck, dispatch } from "../industries/retail/workflows/fulfilment/fulfil/index.ts";
import type { Order, Settings } from "../industries/retail/workflows/fulfilment/fulfil/types.ts";

const DIR = "industries/retail/workflows/fulfilment/fulfil";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const S: Settings = { business_name: "Test Store", unleashed: { warehouse_code: "MAIN", order_status: "Placed" } };
const G1 = "11111111-2222-4333-8444-555555555551", G2 = "11111111-2222-4333-8444-555555555552";

const ORDERS = [
  { OrderNumber: "SO-1001", Guid: G1, CustomerName: "Pat Shop", Warehouse: { WarehouseCode: "MAIN" },
    SalesOrderLines: [{ LineNumber: 1, ProductCode: "SKU-A", OrderQuantity: 2 }, { LineNumber: 2, ProductCode: "SKU-B", OrderQuantity: 1 }] },
  { OrderNumber: "SO-1002", Guid: G2, CustomerName: "Lee Co", Warehouse: { WarehouseCode: "MAIN" },
    SalesOrderLines: [{ LineNumber: 1, ProductCode: "SKU-B", OrderQuantity: 5 }] },
];
// SKU-B has 3 in MAIN: SO-1001 takes 1, leaving 2, so SO-1002 (needs 5) is short. A stock row in another warehouse must not count.
const STOCK = [
  { ProductCode: "SKU-A", Warehouse: { WarehouseCode: "MAIN" }, AvailableQty: 10 },
  { ProductCode: "SKU-B", Warehouse: { WarehouseCode: "MAIN" }, AvailableQty: 3 },
  { ProductCode: "SKU-B", Warehouse: { WarehouseCode: "OTHER" }, AvailableQty: 50 },
];

/** A context whose draft reads come from canned data. The gate is the runtime's: only the workflow's draft ops may run. */
function fakeCtx(store: MemoryStore, calls: string[]) {
  const ctx = context(WF, S, store, NOW, () => {});
  ctx.draft = (async (a: any) => {
    if (!(WF.draft_ops[a.platform] ?? []).includes(a.op)) throw new Error(`${WF.id}: ${a.op} is not a draft op`);
    calls.push(a.op);
    const data = a.op === "docs.get_SalesOrders" ? { Pagination: {}, Items: ORDERS }
      : a.op === "docs.get_StockOnHand" ? { Pagination: {}, Items: STOCK } : undefined;
    if (!data) throw new Error(`unfaked op ${a.op}`);
    return { status: 200, data, headers: new Headers() };
  }) as any;
  return ctx;
}

async function runAll(store: MemoryStore, calls: string[] = []) {
  await intake(fakeCtx(store, calls));
  await stockCheck(fakeCtx(store, calls));
  await dispatch(fakeCtx(store, calls));
}

test("the crons only read; a shipment is queued as a live op, never run", async () => {
  const store = new MemoryStore(), calls: string[] = [];
  await runAll(store, calls);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((op) => op.startsWith("docs.get_")), calls.join(", "));
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].acts[0].op, "docs.post_SalesShipments");
});

test("a live op cannot be run as a draft", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "unleashed", op: "docs.post_SalesShipments", summary: "x" }), /not a draft operation/);
});

test("ready orders queue once, short orders wait, and re-runs never double-queue", async () => {
  const store = new MemoryStore();
  await runAll(store);
  const ready = await store.get<Order>("orders", "ord-SO-1001"), short = await store.get<Order>("orders", "ord-SO-1002");
  assert.equal(ready?.status, "queued");
  assert.equal(short?.status, "short");
  assert.deepEqual(short?.short, ["SKU-B"]);
  await runAll(store);
  await runAll(store);
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1, "one shipment for one ready order, however often the crons run");
});

test("an approved shipment is attempted and blocked: the write gate, then the missing signer", async () => {
  const store = new MemoryStore();
  await runAll(store);
  const id = (await store.get<Order>("orders", "ord-SO-1001"))!.dispatch_approval!;
  const ap = await approve(WF, store, id, "oscar@test", NOW);
  assert.equal(ap.status, "failed");
  assert.match(ap.error ?? "", /write blocked|not wired/);
});
