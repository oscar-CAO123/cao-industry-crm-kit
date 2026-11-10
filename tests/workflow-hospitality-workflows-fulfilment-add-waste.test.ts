// Wastage workflow tests. Every request goes to a fake network: no test reaches a real Square account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { WASTE_REASON } from "../industries/hospitality/workflows/fulfilment/add-waste/types.ts";
import { CRONS, catalogue, logWaste, review } from "../industries/hospitality/workflows/fulfilment/add-waste/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/hospitality/workflows/fulfilment/add-waste/workflow.json", "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Venue", location_id: "LOC1", max_quantity: 1000 };
const NOW = new Date("2026-11-08T22:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let changesReply: any[] = [];

function fake() {
  hits = []; changesReply = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/v2/catalog/search-catalog-items") return json({ items: [
        { type: "ITEM", id: "ITEM_CHICKEN", item_data: { name: "Chicken thigh", variations: [{ type: "ITEM_VARIATION", id: "VAR_CHICKEN", item_variation_data: { name: "1 kg", track_inventory: true } }] } },
        { type: "ITEM", id: "ITEM_BUN", item_data: { name: "Brioche bun", variations: [{ type: "ITEM_VARIATION", id: "VAR_BUN", item_variation_data: { name: "each", track_inventory: true } }] } },
      ] });
      if (p === "/v2/inventory/adjustment-reasons") return json({ adjustment_reasons: [{ id: { type: "SPOILAGE_WASTE" } }, { id: { type: "DAMAGED" } }] });
      if (p === "/v2/inventory/changes/batch-retrieve") return json({ changes: changesReply });
      if (p === "/v2/inventory/changes/batch-create") return json({ changes: [{ adjustment: { id: "ADJ1" } }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.path === "/v2/inventory/changes/batch-create");
const entry = (id: string, variation_id: string, quantity: string) => ({ id, variation_id, quantity, status: "identified", created: NOW.toISOString() });

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SQUARE_ACCESS_TOKEN: "sq-test-token", KIT_ALLOW_WRITES: "1" });
});

test("every cron named in workflow.json has a function, and no live operation can be drafted", async () => {
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `${c.entry} is exported`);
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "square", op: "api.BatchChangeInventory", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "square", op: "api.SearchCatalogItems", summary: "x" }), /not a live operation/);
});

test("catalogue cron reads items and reasons into the store and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await catalogue(ctx), { items: 2, waste_reason: true });
  assert.equal((await store.get<any>("waste-catalogue", "VAR_CHICKEN")).name, "1 kg");
  assert.equal(writes().length, 0, "a read cron writes nothing to Square");
});

test("waste entries are queued for approval, never sent; re-runs never queue twice; approval runs the adjustment once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await catalogue(ctx);
  await store.put("waste", "bin-0001", { ...entry("bin-0001", "VAR_CHICKEN", "1.5"), note: "dropped tray" });
  assert.deepEqual(await logWaste(ctx), { queued: 1, held: 0 });
  assert.equal(writes().length, 0, "nothing written to Square by a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.match(pending[0].summary, /Log 1\.5 of 1 kg as waste/);

  await logWaste(ctx); await logWaste(ctx);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "re-runs never double-queue");
  assert.equal((await store.get<any>("waste", "bin-0001")).status, "queued");

  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(writes().length, 1, "approval sends the adjustment once");
  const change = writes()[0].body.changes[0].adjustment;
  assert.equal(change.catalog_object_id, "VAR_CHICKEN");
  assert.equal(change.from_state, "IN_STOCK");
  assert.equal(change.to_state, "WASTE");
  assert.equal(change.quantity, "1.5");
  assert.equal(change.reason_id.type, WASTE_REASON);
  assert.equal(writes()[0].body.idempotency_key.length, 45);
  await assert.rejects(approve(WF, store, pending[0].id, "owner", NOW), /already done/);
});

test("entries that do not check out are parked, never queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await catalogue(ctx);
  await store.put("waste", "bin-0002", entry("bin-0002", "VAR_NOT_IN_CATALOGUE", "2"));
  await store.put("waste", "bin-0003", entry("bin-0003", "VAR_BUN", "0"));
  await store.put("waste", "bin-0004", entry("bin-0004", "VAR_BUN", "5000"));
  await store.put("waste", "bin-0005", entry("bin-0005", "VAR_BUN", "-1"));
  assert.deepEqual(await logWaste(ctx), { queued: 0, held: 4 });
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
  assert.equal((await store.get<any>("waste", "bin-0004")).status, "needs-review");
  assert.match((await store.get<any>("waste", "bin-0002")).problem, /not in the catalogue/);
});

test("without KIT_ALLOW_WRITES the approved adjustment is refused before any socket opens", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await catalogue(ctx);
  await store.put("waste", "bin-0006", entry("bin-0006", "VAR_BUN", "3"));
  await logWaste(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  process.env.KIT_ALLOW_WRITES = "0";
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "failed");
  assert.equal(writes().length, 0);
});

test("logWaste holds everything until the waste reason is in the catalogue", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("waste-reasons", "current", { types: ["DAMAGED"], at: NOW.toISOString() });
  await store.put("waste", "bin-0007", entry("bin-0007", "VAR_BUN", "1"));
  assert.deepEqual(await logWaste(ctx), { queued: 0, held: 0 });
  assert.equal((await store.get<any>("waste", "bin-0007")).status, "identified");
});

test("review cron sums the day's waste adjustments into the store and writes nothing to Square", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await catalogue(ctx);
  changesReply = [
    { type: "ADJUSTMENT", adjustment: { catalog_object_id: "VAR_CHICKEN", to_state: "WASTE", quantity: "1.5", reason_id: { type: "SPOILAGE_WASTE" } } },
    { type: "ADJUSTMENT", adjustment: { catalog_object_id: "VAR_CHICKEN", to_state: "WASTE", quantity: "0.25", reason_id: { type: "SPOILAGE_WASTE" } } },
    { type: "ADJUSTMENT", adjustment: { catalog_object_id: "VAR_BUN", to_state: "WASTE", quantity: "2", reason_id: { type: "DAMAGED" } } },
  ];
  assert.deepEqual(await review(ctx), { changes: 2, items: 1 });
  const day = await store.get<any>("waste-days", "2026-11-08");
  assert.equal(day.changes, 2);
  assert.deepEqual(day.items, [{ variation_id: "VAR_CHICKEN", name: "1 kg", quantity: 1.75 }]);
  assert.equal(writes().length, 0);
  assert.equal(hits.filter((h) => h.path === "/v2/inventory/changes/batch-retrieve").length, 1);
});
