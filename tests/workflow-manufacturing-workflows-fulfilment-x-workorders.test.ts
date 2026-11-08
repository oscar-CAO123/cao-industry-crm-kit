// Work-orders workflow tests. No test reaches a real account: the transport answers only Unleashed's host, from fixtures,
// and throws on anything else. Every call runs through the kit's real Unleashed signer (core/sdk/call.ts), so each request
// is checked for its api-auth-signature. The allowlist rules run on the real runtime.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { plan, materials, complete } from "../industries/manufacturing/workflows/fulfilment/x-workorders/index.ts";

const DIR = "industries/manufacturing/workflows/fulfilment/x-workorders";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const S: any = {
  family: "production-plan", warehouse_code: "MAIN", horizon_days: 30,
  production_plan: [{ product_code: "BOOKSHELF", units_per_day: 4 }],
  components: [{ product_code: "SIDE", min: 20, max: 80 }, { product_code: "STAIN", min: 10, max: 40 }],
};
const NOW = new Date("2026-11-09T00:00:00Z");
const G1 = "11111111-2222-4333-8444-555555555555", G2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const API = { id: "test-api-id", key: "test-api-key", client: "kit-test" };

interface Hit { label: string; method: string; search: string; headers: Record<string, string>; body?: any }
let hits: Hit[] = [];
let assemblies: any[] = [];
let stock: any[] = [];
let completeStatus = 200;

const parked = (guid: string, code: string, qty: number, due: string) =>
  ({ Guid: guid, AssemblyNumber: `ASM-${guid.slice(0, 4)}`, AssemblyStatus: "Parked", Quantity: qty, AssembleBy: `${due}T00:00:00`, Product: { ProductCode: code } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const page = (items: unknown[]) => ({ Items: items, Pagination: { PageNumber: 1, NumberOfPages: 1 } });

/** The fake Unleashed. It records every request it is handed (before it answers), then serves the four mapped operations. */
async function fakeFetch(url: string, init: any): Promise<Response> {
  const u = new URL(url);
  const label = `${init.method} ${u.pathname}`;
  hits.push({ label, method: init.method, search: u.search.replace(/^\?/, ""), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  if (u.hostname !== "api.unleashedsoftware.com") throw new Error(`test: unexpected host ${u.hostname}`);
  if (label === "GET /Assemblies") return json(page(assemblies));
  if (label === "GET /StockOnHand") return json(page(stock));
  if (label === "POST /Assemblies") return json({ Guid: G1, AssemblyStatus: "Parked" });
  if (/^POST \/Assemblies\/[0-9a-f-]{36}\/Complete$/i.test(label)) return json({ AssemblyStatus: "Completed" }, completeStatus);
  throw new Error(`test: no fixture for ${label}`);
}

/** A runtime context on the real call path: draft reads and parks go to the fake Unleashed through the signer. */
function ctxFor(store = new MemoryStore(), settings = S, now = NOW) {
  return context(WF, settings, store, now, () => {});
}

const completes = () => hits.filter((h) => h.label.startsWith("POST /Assemblies/") && h.label.endsWith("/Complete"));

beforeEach(() => {
  hits = []; assemblies = []; stock = []; completeStatus = 200;
  setTransport({ sleep: async () => {}, log: () => {}, fetch: fakeFetch as any });
  process.env.KIT_ALLOW_WRITES = "1";
  process.env.UNLEASHED_API_ID = API.id;
  process.env.UNLEASHED_API_KEY = API.key;
  process.env.UNLEASHED_CLIENT_TYPE = API.client;
});

test("runtime: a live operation cannot be drafted and a draft operation cannot be queued", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "unleashed", op: "docs.post_Assemblies_assemblyGuid_Complete", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "unleashed", op: "docs.get_Assemblies", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0, "refused before any request");
});

test("signing: every Unleashed request carries the kit's HMAC-SHA256 signature of its query string", async () => {
  assemblies = [parked(G2, "BOOKSHELF", 120, "2026-12-09")];
  stock = [{ ProductCode: "SIDE", QtyOnHand: 5 }];
  await plan(ctxFor());
  await materials(ctxFor());
  const get = hits.find((h) => h.label === "GET /Assemblies")!;
  assert.equal(get.headers["api-auth-id"], API.id);
  assert.equal(get.headers["client-type"], API.client);
  assert.equal(get.headers["api-auth-signature"], createHmac("sha256", API.key).update(get.search, "utf8").digest("base64"));
  assert.match(get.search, /assemblyStatus=Parked/);
  const stockRead = hits.find((h) => h.label === "GET /StockOnHand")!;
  assert.match(stockRead.search, /warehouseCode=MAIN/);
  for (const h of hits) assert.ok(h.headers["api-auth-signature"], `${h.label} is unsigned`);
});

test("plan: parks one work order per planned product, sized from units per day over the horizon", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await plan(ctxFor(store)), { raised: 1, covered: 0 });
  const post = hits.find((h) => h.label === "POST /Assemblies")!;
  assert.equal(post.body.Product.ProductCode, "BOOKSHELF");
  assert.equal(post.body.Quantity, 120);
  assert.equal(post.body.AssembleBy, "2026-12-09T00:00:00");
  assert.equal(completes().length, 0, "plan never completes anything");
});

test("plan: a re-run with the same store raises nothing, even when the read shows no open order", async () => {
  const store = new MemoryStore();
  await plan(ctxFor(store));
  hits = [];
  assert.deepEqual(await plan(ctxFor(store)), { raised: 0, covered: 1 });
  assert.equal(hits.filter((h) => h.label === "POST /Assemblies").length, 0);
});

test("plan: a product with an open parked order is covered, not raised again", async () => {
  assemblies = [parked(G2, "BOOKSHELF", 120, "2026-12-09")];
  assert.deepEqual(await plan(ctxFor()), { raised: 0, covered: 1 });
  assert.equal(hits.filter((h) => h.label === "POST /Assemblies").length, 0);
});

test("materials: lists components below minimum with the amount to order, and orders nothing", async () => {
  stock = [{ ProductCode: "SIDE", QtyOnHand: 12 }, { ProductCode: "STAIN", QtyOnHand: 90 }];
  const store = new MemoryStore();
  const r = await materials(ctxFor(store)) as any;
  assert.deepEqual(r.below_minimum, [{ product_code: "SIDE", on_hand: 12, min: 20, max: 80, to_order: 68 }]);
  assert.deepEqual(hits.map((h) => h.label), ["GET /StockOnHand"]);
  assert.equal((await store.get<any>("shortfalls", "latest"))?.items.length, 1);
});

test("complete: queues each due parked order once, and a re-run never queues it again", async () => {
  assemblies = [parked(G1, "BOOKSHELF", 120, "2026-11-01"), parked(G2, "BOOKSHELF", 120, "2026-12-30")];
  const store = new MemoryStore();
  assert.deepEqual(await complete(ctxFor(store)), { queued: 1 });
  assert.deepEqual(await complete(ctxFor(store)), { queued: 1 }, "the count is due orders; the queue itself holds one entry");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].acts[0].op, "docs.post_Assemblies_assemblyGuid_Complete");
  assert.equal(completes().length, 0, "the cron never completes; it queues");
});

test("approval: a queued completion is sent only after a person approves it, once, and signed", async () => {
  assemblies = [parked(G1, "BOOKSHELF", 120, "2026-11-01")];
  const store = new MemoryStore();
  await complete(ctxFor(store));
  assert.equal(completes().length, 0, "nothing completes before approval");
  const id = approvalId(WF.id, `complete:${G1}`);
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(completes().length, 1);
  assert.equal(completes()[0].label, `POST /Assemblies/${G1}/Complete`);
  assert.ok(completes()[0].headers["api-auth-signature"], "the completion is signed");
  await assert.rejects(approve(WF, store, id, "owner", NOW), /already done/);
  assert.equal(completes().length, 1, "a second approval never completes it again");
});

test("approval: a completion Unleashed refuses is marked failed, and a later approval retries it", async () => {
  assemblies = [parked(G1, "BOOKSHELF", 120, "2026-11-01")];
  const store = new MemoryStore();
  await complete(ctxFor(store));
  const id = approvalId(WF.id, `complete:${G1}`);
  completeStatus = 500;
  const failed = await approve(WF, store, id, "owner", NOW);
  assert.equal(failed.status, "failed");
  completeStatus = 200;
  const retried = await approve(WF, store, id, "owner", NOW);
  assert.equal(retried.status, "done");
  assert.equal(completes().length, 2, "one refused attempt, one accepted");
});

test("settings: a bad product code is refused before any read or write", async () => {
  const bad = { ...S, production_plan: [{ product_code: "BOOK SHELF!", units_per_day: 4 }] };
  await assert.rejects(plan(ctxFor(new MemoryStore(), bad)), /bad production_plan entry/);
  assert.equal(hits.length, 0);
});
