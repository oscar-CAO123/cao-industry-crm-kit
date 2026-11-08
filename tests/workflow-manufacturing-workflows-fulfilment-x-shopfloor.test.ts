// Shop-floor workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval, type Ctx } from "../core/workflows/runtime.ts";
import { schedule, stock, completeBuilds, CRONS } from "../industries/manufacturing/workflows/fulfilment/x-shopfloor/index.ts";
import type { Settings } from "../industries/manufacturing/workflows/fulfilment/x-shopfloor/types.ts";

const DIR = "industries/manufacturing/workflows/fulfilment/x-shopfloor/";
const WF = JSON.parse(fs.readFileSync(DIR + "workflow.json", "utf8")) as WorkflowRecord;
const OPS = JSON.parse(fs.readFileSync("core/sdk/platforms/unleashed/ops.json", "utf8")) as { id: string; method: string }[];
const NOW = new Date("2026-11-09T00:00:00Z");
const S: Settings = { ready_status: "Ready to complete", reorder_levels: { "BOLT-M8": 100, "PANEL-1200": 20 } };
const G1 = "11111111-2222-4333-8444-555555555555", G2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let netHits = 0;
let lastReq: { url: string; method?: string; headers: Headers; body?: unknown } | undefined;
beforeEach(() => {
  netHits = 0;
  lastReq = undefined;
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: string, init?: RequestInit) => {
    netHits++;
    lastReq = { url, method: init?.method, headers: new Headers(init?.headers), body: init?.body };
    return new Response("{}", { status: 200 });
  }) as any });
  Object.assign(process.env, { UNLEASHED_API_ID: "id", UNLEASHED_API_KEY: "key", UNLEASHED_CLIENT_TYPE: "kit-test", KIT_ALLOW_WRITES: "1" });
});

// A context whose platform reads return fixed rows. Queueing stays the real runtime, so approval rules still apply.
function withReads(store: MemoryStore, rows: { assemblies?: unknown[]; stock?: unknown[] }) {
  const base = context(WF, S, store, NOW, () => {});
  const draft: Ctx<Settings>["draft"] = (async (a: { op: string }) => ({
    status: 200, headers: new Headers(),
    data: { Items: a.op === "docs.get_StockOnHand" ? rows.stock ?? [] : rows.assemblies ?? [] },
  })) as any;
  return { ...base, draft } as Ctx<Settings>;
}

test("the record only lists mapped Unleashed operations: drafts are reads, live ops are writes", () => {
  const kind = new Map(OPS.map((o) => [o.id, o.method]));
  for (const op of WF.draft_ops.unleashed) assert.equal(kind.get(op), "GET", `${op} must be a read`);
  for (const op of WF.live_ops.unleashed) assert.notEqual(kind.get(op), "GET", `${op} must be a write`);
  for (const op of WF.live_ops.unleashed) assert.ok(!WF.draft_ops.unleashed.includes(op), `${op} is in both lists`);
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.equal(WF.id, "manufacturing:x-shopfloor");
});

test("a cron cannot run a live operation as a draft, and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "unleashed", op: "docs.post_Assemblies_assemblyGuid_Complete", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "unleashed", op: "docs.get_Assemblies", summary: "x" }), /not a live operation/);
  assert.equal(netHits, 0);
});

test("schedule puts the open builds on the board as a draft and sends nothing", async () => {
  const store = new MemoryStore();
  await schedule(withReads(store, { assemblies: [{ Guid: G1, AssemblyNumber: "AS-1", AssemblyStatus: "Parked", Product: { ProductCode: "PANEL-1200" }, Quantity: 40, AssemblyDate: "2026-11-10" }] }));
  const board = await store.get<{ builds: { number: string; product: string; quantity: number }[] }>("shopfloor", "board");
  assert.equal(board?.builds.length, 1);
  assert.deepEqual([board?.builds[0].number, board?.builds[0].product, board?.builds[0].quantity], ["AS-1", "PANEL-1200", 40]);
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("stock flags only the components under their minimum, across warehouses", async () => {
  const store = new MemoryStore();
  await stock(withReads(store, { stock: [
    { ProductCode: "BOLT-M8", QtyOnHand: 60, WarehouseCode: "MAIN" },
    { ProductCode: "BOLT-M8", QtyOnHand: 30, WarehouseCode: "SHOP" },
    { ProductCode: "PANEL-1200", QtyOnHand: 25, WarehouseCode: "MAIN" },
  ] }));
  const list = await store.get<{ short: { code: string; on_hand: number; minimum: number }[] }>("shopfloor", "stock");
  assert.deepEqual(list?.short, [{ code: "BOLT-M8", on_hand: 90, minimum: 100 }]);
});

test("complete-builds queues a ready build once, however often it runs", async () => {
  const store = new MemoryStore();
  const rows = [
    { Guid: G1, AssemblyNumber: "AS-1", AssemblyStatus: "Ready to complete", Product: { ProductCode: "PANEL-1200" }, Quantity: 40 },
    { Guid: G2, AssemblyNumber: "AS-2", AssemblyStatus: "Parked", Product: { ProductCode: "BOLT-M8" }, Quantity: 5 },
  ];
  await completeBuilds(withReads(store, { assemblies: rows }));
  await completeBuilds(withReads(store, { assemblies: rows }));
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1, "one approval, not one per run");
  assert.equal(aps[0].status, "pending");
  assert.equal(aps[0].acts[0].op, "docs.post_Assemblies_assemblyGuid_Complete");
  assert.deepEqual(aps[0].acts[0].input, { params: { assemblyGuid: G1 } });
  assert.equal(netHits, 0, "queueing reaches no network");
});

test("a build with a malformed guid never reaches a path", async () => {
  const store = new MemoryStore();
  await completeBuilds(withReads(store, { assemblies: [{ Guid: "../../etc", AssemblyStatus: "Ready to complete", Quantity: 1 }] }));
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("an approved completion sends one signed POST through the gate, and a re-run never queues it again", async () => {
  const store = new MemoryStore();
  const rows = [{ Guid: G1, AssemblyStatus: "Ready to complete", Product: { ProductCode: "PANEL-1200" }, Quantity: 40 }];
  await completeBuilds(withReads(store, { assemblies: rows }));
  const [id] = Object.keys(await store.list("approvals"));
  assert.equal(netHits, 0, "queued, not sent");
  const ap = await approve(WF, store, id, "oscar", NOW);
  assert.equal(ap.status, "done", ap.error);
  assert.equal(netHits, 1, "exactly one request, after approval");
  assert.equal(lastReq?.method, "POST");
  assert.equal(lastReq?.url, `https://api.unleashedsoftware.com/Assemblies/${G1}/Complete`);
  assert.equal(lastReq?.headers.get("api-auth-id"), "id");
  assert.equal(lastReq?.headers.get("client-type"), "kit-test");
  assert.equal(lastReq?.headers.get("api-auth-signature"), createHmac("sha256", "key").update("").digest("base64"));
  assert.ok(!lastReq?.body, "no body is sent for this operation");
  // A cron that runs again does not queue the completed build a second time, and sends nothing.
  await completeBuilds(withReads(store, { assemblies: rows }));
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
  assert.equal(netHits, 1);
});
