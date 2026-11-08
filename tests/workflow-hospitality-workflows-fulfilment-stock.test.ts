// Hand-count drinks workflow tests. Every request goes to a fake network: no test reaches a real Square account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { snapshot, reconcile, postCounts, CRONS } from "../industries/hospitality/workflows/fulfilment/stock/index.ts";
import { main } from "../tools/workflow.ts";
import fs from "node:fs";

const DIR = "industries/hospitality/workflows/fulfilment/stock";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T10:00:00Z");
const COUNT = "count-2026-11-09-main";

type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];
let batchStatus = 200;

function fake() {
  hits = []; batchStatus = 200;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v2/locations") return json({ locations: [{ id: "L1", name: "Main bar", status: "ACTIVE" }, { id: "L2", name: "Cellar", status: "INACTIVE" }] });
      if (p === "/v2/catalog/list") {
        if (u.searchParams.get("cursor") === "page2") return json({ objects: [
          { type: "ITEM", id: "ITEM2", item_data: { name: "Gin" } },
          { type: "ITEM_VARIATION", id: "V3", item_variation_data: { item_id: "ITEM2", name: "700ml", track_inventory: true } }] });
        return json({ cursor: "page2", objects: [
          { type: "ITEM", id: "ITEM1", item_data: { name: "Pale ale" } },
          { type: "ITEM_VARIATION", id: "V1", item_variation_data: { item_id: "ITEM1", name: "Keg 50L", track_inventory: true } },
          { type: "ITEM_VARIATION", id: "V2", item_variation_data: { item_id: "ITEM1", name: "Can", track_inventory: false } }] });
      }
      if (p === "/v2/inventory/V1") return json({ counts: [
        { catalog_object_id: "V1", location_id: "L1", state: "IN_STOCK", quantity: "10", calculated_at: "2026-11-09T09:00:00Z" },
        { catalog_object_id: "V1", location_id: "L2", state: "IN_STOCK", quantity: "3", calculated_at: "2026-11-09T09:00:00Z" }] });
      if (p === "/v2/inventory/V3") return json({ counts: [{ catalog_object_id: "V3", location_id: "L1", state: "IN_STOCK", quantity: "4", calculated_at: "2026-11-09T09:00:00Z" }] });
      if (p === "/v2/inventory/changes/batch-create") return json({ changes: [] }, batchStatus);
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const writes = () => hits.filter((h) => h.method !== "GET");
const countRec = (over: Record<string, unknown> = {}) => ({
  id: COUNT, location_id: "L1", taken_at: "2026-11-09T09:30:00Z", status: "new",
  lines: [{ catalog_object_id: "V1", name: "Pale ale Keg 50L", quantity: 9 }, { catalog_object_id: "V3", name: "Gin 700ml", quantity: 4 }],
  ...over,
});

beforeEach(() => {
  fake();
  Object.assign(process.env, { SQUARE_ACCESS_TOKEN: "sq-test", KIT_ALLOW_WRITES: "1" });
});

test("every cron in workflow.json has an entry point", () => {
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", c.entry);
});

test("snapshot: reads tracked drinks at active locations and writes nothing to the POS", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await snapshot(context(WF, {}, store, NOW, () => {})), { locations: 1, items: 2, levels: 2 });
  assert.equal(writes().length, 0, "no write");
  assert.equal(hits.some((h) => h.path === "/v2/inventory/V2"), false, "untracked item is not read");
  assert.equal(new URLSearchParams(hits.find((h) => h.path === "/v2/catalog/list")!.search).get("types"), "ITEM,ITEM_VARIATION");
  const levels = Object.values(await store.list<any>("stock"));
  assert.equal(levels.length, 2, "the inactive cellar is not counted");
  assert.equal(levels.find((x: any) => x.catalog_object_id === "V1")!.name, "Pale ale Keg 50L");
});

test("reconcile: compares each hand count with the system count and records differences, changing nothing", async () => {
  const store = new MemoryStore();
  await store.put("counts", COUNT, countRec());
  assert.deepEqual(await reconcile(context(WF, {}, store, NOW, () => {})), { reconciled: 1, rejected: 0 });
  assert.equal(writes().length, 0, "no write");
  const c = await store.get<any>("counts", COUNT);
  assert.equal(c.status, "reconciled");
  assert.equal(c.differences, 1, "one line differs: the keg");
  const v = Object.values(await store.list<any>("variances")).find((x: any) => x.catalog_object_id === "V1")!;
  assert.deepEqual([v.system_count, v.hand_count, v.difference], [10, 9, -1]);
});

test("reconcile: a count with a bad quantity is rejected before any network call", async () => {
  const store = new MemoryStore();
  await store.put("counts", "count-bad", countRec({ id: "count-bad", lines: [{ catalog_object_id: "V1", name: "Keg", quantity: -2 }] }));
  assert.deepEqual(await reconcile(context(WF, {}, store, NOW, () => {})), { reconciled: 0, rejected: 1 });
  assert.equal(hits.length, 0, "no request");
  assert.match((await store.get<any>("counts", "count-bad"))!.reason, /bad quantity/);
});

test("post-counts: queues the count for approval, never double-queues, and changes the POS only when approved", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, {}, store, NOW, () => {});
  await store.put("counts", COUNT, countRec());
  await reconcile(ctx());
  assert.deepEqual(await postCounts(ctx()), { queued: 1, posted: 0 });
  assert.equal(writes().length, 0, "nothing posted by a cron");
  assert.deepEqual(await postCounts(ctx()), { queued: 0, posted: 0 });
  const pending = (await main(["approvals", DIR], store)) as any[];
  assert.equal(pending.length, 1, "re-runs never queue twice");

  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  const batch = hits.find((h) => h.path === "/v2/inventory/changes/batch-create")!;
  assert.equal(batch.method, "POST");
  assert.equal(batch.body.ignore_unchanged_counts, true);
  assert.deepEqual(batch.body.changes.map((x: any) => [x.type, x.physical_count.catalog_object_id, x.physical_count.location_id, x.physical_count.quantity, x.physical_count.state]),
    [["PHYSICAL_COUNT", "V1", "L1", "9", "IN_STOCK"], ["PHYSICAL_COUNT", "V3", "L1", "4", "IN_STOCK"]]);
  assert.equal(batch.body.changes[0].physical_count.occurred_at, "2026-11-09T09:30:00.000Z");
  assert.match(batch.body.idempotency_key, /^[0-9a-f]{40}$/);

  assert.deepEqual(await postCounts(ctx()), { queued: 0, posted: 1 });
  assert.equal((await store.get<any>("counts", COUNT)).status, "posted");
  await assert.rejects(approve(WF, store, pending[0].id, "owner", NOW), /already done/);
});

test("an approved count with writes blocked by the deploy does not reach the POS", async () => {
  const store = new MemoryStore(), ctx = context(WF, {}, store, NOW, () => {});
  await store.put("counts", COUNT, countRec());
  await reconcile(ctx);
  await postCounts(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  process.env.KIT_ALLOW_WRITES = "0";
  const r = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(r.status, "failed");
  assert.equal(writes().length, 0, "no write reached the POS");
});

test("runtime: a cron cannot run the POS write on its own, and cannot queue a read", async () => {
  const ctx = context(WF, {}, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "square", op: "api.BatchChangeInventory", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "square", op: "api.ListLocations", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});
