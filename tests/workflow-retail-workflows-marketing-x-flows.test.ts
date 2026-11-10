// Email flows workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, approvalId, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { performance, review, goLive } from "../industries/retail/workflows/marketing/x-flows/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/retail/workflows/marketing/x-flows/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const SETTINGS: any = { business_name: "Test Store", klaviyo: { conversion_metric_id: "RESQ6t", timeframe: "last_30_days", target_conversion_rate: 0.02, min_recipients: 500 } };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let flowStatus: Record<string, string> = {};

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/api/flows" && m === "GET") return json({ data: [
        { id: "F1", attributes: { name: "Welcome series", status: "live", trigger_type: "Metric" } },
        { id: "F2", attributes: { name: "Abandoned cart", status: "live", trigger_type: "Metric" } },
        { id: "F3", attributes: { name: "Win-back v2", status: flowStatus.F3 ?? "draft", trigger_type: "Metric" } },
        { id: "F4", attributes: { name: "Tiny test", status: "live", trigger_type: "Metric" } }], links: {} });
      if (p === "/api/flow-values-reports" && m === "POST") return json({ data: { type: "flow-values-report", attributes: { results: [
        { groupings: { flow_id: "F1" }, statistics: { recipients: 1000, conversions: 30, conversion_rate: 0.03, conversion_value: 4200 } },
        { groupings: { flow_id: "F2" }, statistics: { recipients: 800, conversions: 8, conversion_rate: 0.01, conversion_value: 640 } },
        { groupings: { flow_id: "F4" }, statistics: { recipients: 40, conversions: 0, conversion_rate: 0, conversion_value: 0 } }] } } });
      if (p === "/api/flows/F2/flow-actions" && m === "GET") return json({ data: [{ id: "A1", type: "flow-action" }, { id: "A2", type: "flow-action" }] });
      if (p === "/api/flows/F3" && m === "PATCH") { flowStatus.F3 = "live"; return json({ data: { type: "flow", id: "F3", attributes: { status: "live" } } }); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method === "PATCH" || (h.method === "POST" && h.path !== "/api/flow-values-reports"));

beforeEach(() => {
  flowStatus = {}; fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { KLAVIYO_API_KEY: "test-kl", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft the live switch and cannot queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "klaviyo", op: "update_flow", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "klaviyo", op: "get_flows", summary: "x" }), /not a live operation/);
});

test("the SDK gate blocks the results query when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(performance(ctx), WriteBlocked);
  assert.equal(hits.filter((h) => h.method === "POST").length, 0);
});

test("performance refuses to run without a conversion metric", async () => {
  const ctx = context(WF, { ...SETTINGS, klaviyo: { ...SETTINGS.klaviyo, conversion_metric_id: "" } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(performance(ctx), /conversion_metric_id/);
});

test("performance and review only read: a scorecard and one sprint are recorded, nothing changes in Klaviyo", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await performance(ctx), { flows: 4 });
  const card = await store.get<any>("scorecard", "latest");
  assert.equal(card.flows.find((f: any) => f.id === "F2").conversion_rate, 0.01);
  assert.equal(hits.find((h) => h.path === "/api/flow-values-reports")!.body.data.attributes.conversion_metric_id, "RESQ6t");
  assert.equal(writes().length, 0);
  assert.deepEqual(await review(ctx), { opened: 1, flow: "Abandoned cart" });
  assert.deepEqual((await store.get<any>("sprints", "F2")).action_ids, ["A1", "A2"]);
  assert.equal(writes().length, 0, "a sprint is a record, not a change in Klaviyo");
  assert.deepEqual(await review(ctx), { opened: 0 }, "one sprint per flow: a re-run opens nothing");
});

test("go-live only queues: nothing reaches Klaviyo until a person approves, and re-runs never queue twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await performance(ctx);
  assert.deepEqual(await goLive(ctx), { queued: 0 });
  await store.put("ready", "F3", { flow_id: "F3", marked_by: "owner", marked: NOW.toISOString() });
  assert.deepEqual(await goLive(ctx), { queued: 1 });
  assert.deepEqual(await goLive(ctx), { queued: 1 });
  assert.equal(Object.keys(await store.list<any>("approvals")).length, 1, "one approval, however often the cron runs");
  assert.equal(writes().length, 0, "queued, not sent");
  const id = approvalId(WF.id, `live:F3:${NOW.toISOString()}`);
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  const patch = hits.find((h) => h.method === "PATCH")!;
  assert.equal(patch.path, "/api/flows/F3");
  assert.deepEqual(patch.body, { data: { type: "flow", id: "F3", attributes: { status: "live" } } });
  await assert.rejects(approve(WF, store, id, "owner"), /already done/);
});

test("a rejected go-live is not queued again by a re-run, and a fresh ready mark queues a new approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await performance(ctx);
  await store.put("ready", "F3", { flow_id: "F3", marked_by: "owner", marked: NOW.toISOString() });
  await goLive(ctx);
  await reject(WF, store, approvalId(WF.id, `live:F3:${NOW.toISOString()}`), "owner", NOW);
  await goLive(ctx);
  assert.equal(Object.keys(await store.list<any>("approvals")).length, 1, "a rejected switch is not queued again by a re-run");
  const later = new Date(NOW.getTime() + 86_400_000);
  await store.put("ready", "F3", { flow_id: "F3", marked_by: "owner", marked: later.toISOString() });
  await goLive(ctx);
  assert.equal(Object.keys(await store.list<any>("approvals")).length, 2, "a fresh ready mark queues a new approval");
  const ap = await approve(WF, store, approvalId(WF.id, `live:F3:${later.toISOString()}`), "owner", later);
  assert.equal(ap.status, "done");
  assert.equal(hits.find((h) => h.method === "PATCH")!.path, "/api/flows/F3");
});
