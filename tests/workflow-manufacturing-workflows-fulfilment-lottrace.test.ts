// Lot trace workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS, lotSync, stockPosition, auditRegister, quarantine } from "../industries/manufacturing/workflows/fulfilment/lottrace/index.ts";
import fs from "node:fs";

const DIR = "industries/manufacturing/workflows/fulfilment/lottrace";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const S: any = { business_name: "Test Fabrication", quarantine_warehouse: "QUAR", warehouse_codes: ["MAIN"] };
const NOW = new Date("2026-11-09T00:00:00Z");
const BATCH = "11111111-2222-4333-8444-555555555555", PROD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
// Test values only. The real keys come from the client's secret store.
const KEYS = { UNLEASHED_API_ID: "test-api-id", UNLEASHED_API_KEY: "test-api-key", UNLEASHED_CLIENT_TYPE: "test-client-type" };

type Hit = { method: string; path: string; query: string; body: any; headers: Record<string, string> };
let hits: Hit[] = [];

// Canned Unleashed replies in the shape the docs show ({"Items": [...]}), keyed by endpoint path. The second batch row has a bad guid and must be dropped.
const FIX: Record<string, any> = {
  BatchNumbers: { Items: [
    { Guid: BATCH, BatchNumber: "HT-0412", ProductCode: "PLATE-5MM", Quantity: 40, WarehouseCode: "MAIN", ExpiryDate: "0001-01-01", Status: "Available" },
    { Guid: "not-a-guid", BatchNumber: "BAD", ProductCode: "PLATE-5MM", WarehouseCode: "MAIN" },
  ] },
  SerialNumbers: { Items: [{ Guid: PROD, SerialNumber: "S-0001", ProductCode: "PLATE-5MM", WarehouseCode: "MAIN", Status: "Available" }] },
  StockOnHand: { Items: [{ Guid: PROD, ProductCode: "PLATE-5MM", WarehouseCode: "MAIN", QtyOnHand: 40, AvailableQty: 35 }] },
  StockCounts: { Items: [{ Guid: BATCH, StockTakeName: "Q4 count", CountDate: "/Date(1762646400000)/", CountType: "Full", Status: "Completed", Warehouse: { WarehouseCode: "MAIN" } }] },
  StockAdjustments: { Items: [{ Guid: PROD, AdjustmentNumber: "SA-00000001", AdjustmentReason: "Damaged", Status: "Confirmed", Warehouse: { WarehouseCode: "MAIN" } }] },
};

function replyFor(method: string, path: string): Response {
  const key = path.replace(/^\//, "");
  let data: unknown = {};
  if (method === "GET" && FIX[key] !== undefined) data = FIX[key];
  if (method === "POST" && key === "WarehouseStockTransfers") data = { Guid: "99999999-8888-4777-8666-555555555555" };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  hits = [];
  Object.assign(process.env, KEYS, { KIT_ALLOW_WRITES: "1" });
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url));
      const method = init?.method ?? "GET";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
      hits.push({ method, path: u.pathname, query: u.search.replace(/^\?/, ""), body, headers });
      return replyFor(method, u.pathname);
    }) as any,
  });
});

/** Every Unleashed request carries the three sign-in headers, and the signature covers the exact query string sent. */
const sign = (query: string) => createHmac("sha256", KEYS.UNLEASHED_API_KEY).update(query, "utf8").digest("base64");
function assertSigned(h: Hit) {
  assert.equal(h.headers["api-auth-id"], KEYS.UNLEASHED_API_ID);
  assert.equal(h.headers["client-type"], KEYS.UNLEASHED_CLIENT_TYPE);
  assert.equal(h.headers["api-auth-signature"], sign(h.query), `signature over "${h.query}"`);
}

const hold = (over: Record<string, unknown> = {}) => ({ guid: BATCH, batch: "HT-0412", product: "PLATE-5MM", qty: 10, from: "MAIN", reason: "bad mill certificate", held_at: NOW.toISOString(), ...over });

test("the allowlists hold: a cron cannot draft a transfer and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "unleashed", op: "docs.post_WarehouseStockTransfers", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "unleashed", op: "docs.get_StockOnHand", summary: "x" }), /not a live operation/);
});

test("a read reaches Unleashed through the signed SDK path", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await stockPosition(ctx), { positions: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, "GET");
  assert.equal(hits[0].path, "/StockOnHand");
  assertSigned(hits[0]);
});

test("a read stops before the network when a sign-in key is missing", async () => {
  delete process.env.UNLEASHED_API_KEY;
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(stockPosition(ctx), /UNLEASHED_API_KEY is not set/);
  assert.equal(hits.length, 0);
});

test("lot-sync indexes valid batches and serials and drops a malformed row", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await lotSync(ctx), { batches: 1, serials: 1 });
  assert.deepEqual(Object.keys(await store.list("lots")), [BATCH]);
  assert.equal((await store.get<any>("lots", BATCH)).batch, "HT-0412");
  assert.deepEqual(hits.map((h) => h.path).sort(), ["/BatchNumbers", "/SerialNumbers"]);
  const batchQuery = hits.find((h) => h.path === "/BatchNumbers")!.query;
  assert.ok(batchQuery.includes("available=true") && batchQuery.includes("pageSize=200"), batchQuery);
  for (const h of hits) { assert.equal(h.method, "GET"); assertSigned(h); }
});

test("stock-position and audit-register read only, and every endpoint they touch is a draft op", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await stockPosition(ctx), { positions: 1 });
  assert.deepEqual(await auditRegister(ctx), { entries: 2 });
  assert.equal((await store.get<any>("positions", PROD)).warehouse, "MAIN");
  assert.deepEqual(Object.keys(await store.list("audit")).sort(), [BATCH, PROD].sort());
  assert.deepEqual(hits.map((h) => h.path).sort(), ["/StockAdjustments", "/StockCounts", "/StockOnHand"]);
  for (const h of hits) {
    assert.equal(h.method, "GET");
    assertSigned(h);
    assert.ok(WF.draft_ops.unleashed.includes(`docs.get_${h.path.slice(1)}`), h.path);
  }
});

test("quarantine queues one transfer for approval, never runs it, and never queues it twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("holds", BATCH, hold());
  assert.deepEqual(await quarantine(ctx), { queued: 1, skipped: 0 });
  assert.deepEqual(await quarantine(ctx), { queued: 0, skipped: 0 }, "a queued hold is marked and skipped");
  const apps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, "pending");
  assert.deepEqual(apps[0].acts.map((a) => a.op), ["docs.post_WarehouseStockTransfers"]);
  assert.equal(apps[0].acts[0].input!.body.DestinationWarehouse.WarehouseCode, "QUAR");
  assert.equal(apps[0].summary, "Move 10 of PLATE-5MM (batch HT-0412) from MAIN to QUAR in Unleashed");
  assert.equal(hits.length, 0, "nothing sent by a cron");
});

test("a hold that fails validation is skipped and never queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("holds", BATCH, hold({ from: "MAIN;DROP" }));
  await store.put("holds", PROD, hold({ guid: PROD, from: "QUAR" }));
  await store.put("holds", "11111111-1111-4111-8111-111111111111", hold({ guid: "11111111-1111-4111-8111-111111111111", qty: 0 }));
  assert.deepEqual(await quarantine(ctx), { queued: 0, skipped: 3 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("the transfer is the only write, and it is sent signed only after approval, once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("holds", BATCH, hold());
  await quarantine(ctx);
  assert.equal(hits.length, 0, "queuing sends nothing");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done", done.error);
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.method, "POST");
  assert.equal(h.path, "/WarehouseStockTransfers");
  assertSigned(h);
  assert.equal(h.body.SourceWarehouse.WarehouseCode, "MAIN");
  assert.equal(h.body.DestinationWarehouse.WarehouseCode, "QUAR");
  assert.deepEqual(h.body.TransferDetails.map((d: any) => [d.Product.ProductCode, d.TransferQuantity]), [["PLATE-5MM", 10]]);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(hits.length, 1, "a second approval never sends the transfer again");
});

test("with writes off, the approved transfer is blocked before anything is called", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("holds", BATCH, hold());
  await quarantine(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "failed");
  assert.equal(hits.length, 0);
});

test("every cron in the workflow record has an entry in CRONS", () => {
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", c.entry);
});
