// Batches and landed costs workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { receive, batchTrace, adjust } from "../industries/retail/workflows/finance-admin/x-batches/index.ts";
import fs from "node:fs";

const FOLDER = "industries/retail/workflows/finance-admin/x-batches";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Retail", cin7: { branch_id: 1, rows: 50 }, adjustment_reason: "Batch count, approved" };
const NOW = new Date("2026-11-09T00:00:00Z");
const BARCODE = "9300000000011";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET";
      // The generated Cin7 ops put "/api" in the server and again in each path (see workflow.json gaps), so the live URL
      // doubles it. This fake accepts both spellings to test the logic; the live URL is not verified by these tests.
      const p = u.pathname.replace(/^\/api\/api\//, "/api/");
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/api/v1/PurchaseOrders" && m === "GET") return json([
        { id: 501, reference: "PO-0501", fullyReceivedDate: "2026-11-07", isVoid: false, modifiedDate: "2026-11-07" },
        { id: 502, reference: "PO-0502", fullyReceivedDate: null, isVoid: false, modifiedDate: "2026-11-08" },
      ]);
      if (p === "/api/v1/PurchaseOrders/501" && m === "GET") return json({ id: 501, reference: "PO-0501", fullyReceivedDate: "2026-11-07",
        productTotal: 400, freightTotal: 40, surcharge: 5,
        lineItems: [{ id: 9001, productId: 7001, code: "TEA-100", name: "Green tea 100g", barcode: BARCODE, qty: 20 }] });
      if (p === "/api/v1/SerialNumbers" && m === "GET") return json([
        { id: 3001, serialnumber: "BATCH-A1", productId: 7001, lineItemId: 9001, code: "TEA-100", available: 20 },
        { id: 3002, serialnumber: "OTHER", productId: 7002, lineItemId: 9999, code: "MUG-01", available: 4 },
      ]);
      if (p === `/api/v1/Stock/${BARCODE}` && m === "GET") return json([
        { productId: 7001, productOptionId: 0, code: "TEA-100", productName: "Green tea 100g", barcode: BARCODE, branchId: 1, stockOnHand: 20, available: 18, openSales: 2, incoming: 0, holding: 0 },
      ]);
      if (p === "/api/v1/Adjustments" && m === "POST") return json([{ id: 8801 }]);
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const posts = () => hits.filter((h) => h.method === "POST");
const env = { CIN7_USERNAME: "user-test", CIN7_API_KEY: "key-test", KIT_ALLOW_WRITES: "1" };

beforeEach(() => {
  fake();
  Object.assign(process.env, env);
});

test("runtime: a cron cannot draft the adjustment and cannot queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "cin7", op: "post /api/v1/Adjustments", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "cin7", op: "get /api/v1/Stock", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("receive and batch-trace record lines, serials and stock, with no writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await receive(ctx), { added: 1 }, "only the fully received PO is recorded");
  assert.deepEqual(await receive(ctx), { added: 0 }, "a second run adds nothing");
  const line = await store.get<any>("receipts", "po501-l9001");
  assert.equal(line.qty, 20);
  assert.equal(line.po_freight_total, 40);
  assert.equal(line.po_surcharge, 5);
  assert.deepEqual(await batchTrace(ctx), { serials: 1, stock: 1 }, "only the serial on a received line is kept");
  assert.equal((await store.get<any>("serials", "serial3001")).serial, "BATCH-A1");
  assert.equal((await store.get<any>("stock", "po501-l9001")).on_hand, 20);
  assert.equal(posts().length, 0, "nothing written to Cin7");
});

test("a proposed adjustment is queued, never run by the cron, and runs once when approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("proposals", "count-1", { key: "count-1", barcode: BARCODE, qty_adjusted: -2, reason: "damaged in store", status: "proposed" });
  assert.deepEqual(await adjust(ctx), { queued: 1, rejected: 0, applied: 0 });
  assert.equal(posts().length, 0, "the cron does not change Cin7");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.deepEqual(await adjust(ctx), { queued: 0, rejected: 0, applied: 0 }, "a re-run never queues twice");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);

  const id = approvalId(WF.id, "adjust:count-1");
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(posts().length, 1, "approval makes the one call");
  const sent = posts()[0].body[0];
  assert.equal(sent.lineItems[0].productId, 7001);
  assert.equal(sent.lineItems[0].qtyAdjusted, -2);
  assert.equal(sent.branchId, 1);

  assert.deepEqual(await adjust(ctx), { queued: 0, rejected: 0, applied: 1 });
  const done = await store.get<any>("proposals", "count-1");
  assert.equal(done.status, "adjusted");
  assert.equal(done.ref.id, "8801");
  await assert.rejects(approve(WF, store, id, "owner"), /already done/);
});

test("no adjustment is queued while no Cin7 branch is set, so it can never land on another branch's stock", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...SETTINGS, cin7: { rows: 50 } }, store, NOW, () => {});
  await store.put("proposals", "count-1", { key: "count-1", barcode: BARCODE, qty_adjusted: -2, status: "proposed" });
  assert.deepEqual(await adjust(ctx), { queued: 0, rejected: 0, applied: 0 });
  assert.equal(hits.length, 0, "no call to Cin7");
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  assert.equal((await store.get<any>("proposals", "count-1")).status, "proposed", "held for a later run, not rejected");
});

test("a bad barcode or quantity is rejected before any call goes out", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("proposals", "bad-bc", { key: "bad-bc", barcode: "../../x", qty_adjusted: 1, status: "proposed" });
  await store.put("proposals", "bad-qty", { key: "bad-qty", barcode: BARCODE, qty_adjusted: 0, status: "proposed" });
  assert.deepEqual(await adjust(ctx), { queued: 0, rejected: 2, applied: 0 });
  assert.equal(hits.length, 0, "no network call for either proposal");
  assert.equal((await store.get<any>("proposals", "bad-bc")).status, "rejected");
  assert.equal((await store.get<any>("proposals", "bad-qty")).status, "rejected");
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});
