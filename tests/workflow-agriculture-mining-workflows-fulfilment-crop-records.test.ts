// Crop and livestock records workflow tests. Every request goes to a fake network: no test reaches a real AgriWebb account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { collect, review, queueRecords } from "../industries/agriculture-mining/workflows/fulfilment/crop-records/index.ts";

const DIR = "industries/agriculture-mining/workflows/fulfilment/crop-records";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const S: any = { business_name: "Test Vineyard", farm_ids: ["FARM1"], stale_days: 14, rain_window_days: 30 };
const NOW = new Date("2026-11-09T00:00:00Z");
const HOUR = 3600e3, DAY = 864e5;

const FARMS = [{ id: "FARM1", name: "Test Vineyard", timeZone: "Australia/Adelaide" }];
const FIELDS = [
  { id: "F1", name: "Block 1", farmId: "FARM1", totalArea: 4.2, unit: "HECTARE", landUse: "CROPPING", cropType: "Shiraz" },
  { id: "F2", name: "Block 2 north", farmId: "FARM1", totalArea: 3.1, unit: "HECTARE", landUse: null, cropType: null },
];
const SESSIONS = [{ id: "S1", name: "Pruning crew", type: "WORK", state: "CLOSED", farmId: "FARM1" }];
const RAIN = [{ id: "R0", value: 8, unit: "mm", sensorId: "GAUGE-1", time: NOW.getTime() - 3 * DAY, mode: "absolute", farmId: "FARM1" }];

let calls: { query: string; variables: any }[] = [];
let mutationsRun = 0;
let mutationInput: any = null;
let recentRecords: unknown[] = [];

function fake() {
  calls = []; mutationsRun = 0; mutationInput = null; recentRecords = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (_url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const q = String(body.query ?? "");
      calls.push({ query: q, variables: body.variables });
      const json = (d: unknown) => new Response(JSON.stringify({ data: d }), { status: 200, headers: { "content-type": "application/json" } });
      if (/^mutation/.test(q)) { mutationsRun++; mutationInput = body.variables?.input; return json({ addRainfalls: { rainfalls: [{ id: "R9", value: 12.5, time: NOW.getTime() - HOUR }] } }); }
      if (/\bfarms\b/.test(q)) return json({ farms: FARMS });
      if (/\bfields\b/.test(q)) return json({ fields: FIELDS });
      if (/\bsessions\b/.test(q)) return json({ sessions: SESSIONS });
      if (/\brecords\b/.test(q)) return json({ records: recentRecords });
      if (/\banimalsWithCount\b/.test(q)) return json({ animalsWithCount: { nonPagedCount: 42 } });
      if (/\brainfalls\b/.test(q)) return json({ rainfalls: RAIN });
      return new Response("not faked: " + q.slice(0, 80), { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake();
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { AGRIWEBB_ACCESS_TOKEN: "test-token", KIT_ALLOW_WRITES: "1" });
});

test("the workflow names only operations the kit maps for agriwebb", () => {
  const ops = JSON.parse(fs.readFileSync("core/sdk/platforms/agriwebb/ops.json", "utf8")) as { id: string }[];
  const known = new Set(ops.map((o) => o.id));
  for (const id of [...WF.draft_ops.agriwebb, ...WF.live_ops.agriwebb]) assert.ok(known.has(id), `${id} is not mapped`);
  assert.deepEqual(WF.live_ops.agriwebb, ["mutation.addRainfalls"]);
});

test("the reading crons read AgriWebb and never write; the review flags the gaps", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await collect(ctx), { farms: 1 });
  assert.deepEqual(await review(ctx), { farms_flagged: 1 });

  assert.equal(mutationsRun, 0, "no cron runs a write");
  assert.ok(calls.length > 0 && calls.every((c) => /^query/.test(c.query)), "every cron call is a query");

  const snap = await store.get<any>("snapshots", "FARM1");
  assert.equal(snap.fields.length, 2);
  assert.equal(snap.animals, 42);
  assert.equal(snap.rainfall.length, 1);
  assert.equal(snap.recent_records, 0);

  const [draft] = Object.values(await store.list<any>("reviews"));
  assert.deepEqual(draft.flags, [
    "No farm record dated in the last 14 days.",
    "No crop type or land use set on: Block 2 north.",
  ]);
});

test("once records and rainfall are present, the review flags only the field still missing a crop type", async () => {
  recentRecords = [{ recordId: "REC1", recordType: "NOTE", observationDate: NOW.getTime() - DAY, sessionId: "S1" }];
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await collect(ctx);
  // Block 2 still has no crop type, so the only flag left is that one.
  assert.deepEqual(await review(ctx), { farms_flagged: 1 });
  const [draft] = Object.values(await store.list<any>("reviews"));
  assert.deepEqual(draft.flags, ["No crop type or land use set on: Block 2 north."]);
});

test("a rainfall proposal is queued by the cron and written only after approval", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await collect(ctx);
  await store.put("proposals", "p1", { kind: "rainfall", farm_id: "FARM1", sensor_id: "GAUGE-1", value: 12.5, time: NOW.getTime() - HOUR, mode: "absolute" });

  assert.deepEqual(await queueRecords(ctx), { queued: 1, refused: 0 });
  assert.equal(mutationsRun, 0, "queuing runs nothing");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["mutation.addRainfalls"]);

  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(mutationsRun, 1);
  assert.deepEqual(mutationInput, [{ farmId: "FARM1", sensorId: "GAUGE-1", value: 12.5, unit: "mm", time: NOW.getTime() - HOUR, mode: "absolute" }]);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("re-runs of the queue cron never queue the same reading twice", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await collect(ctx);
  await store.put("proposals", "p1", { kind: "rainfall", farm_id: "FARM1", sensor_id: "GAUGE-1", value: 5, time: NOW.getTime() - HOUR });
  assert.deepEqual(await queueRecords(ctx), { queued: 1, refused: 0 });
  assert.deepEqual(await queueRecords(ctx), { queued: 0, refused: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
  assert.equal(mutationsRun, 0);
});

test("bad proposals are refused before they reach the queue", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await collect(ctx);
  const t = NOW.getTime() - HOUR;
  await store.put("proposals", "wrong-farm", { kind: "rainfall", farm_id: "FARM9", sensor_id: "GAUGE-1", value: 5, time: t });
  await store.put("proposals", "negative", { kind: "rainfall", farm_id: "FARM1", sensor_id: "GAUGE-1", value: -3, time: t });
  await store.put("proposals", "bad-gauge", { kind: "rainfall", farm_id: "FARM1", sensor_id: "gauge 1; drop", value: 5, time: t });
  await store.put("proposals", "future", { kind: "rainfall", farm_id: "FARM1", sensor_id: "GAUGE-1", value: 5, time: NOW.getTime() + 3 * DAY });
  assert.deepEqual(await queueRecords(ctx), { queued: 0, refused: 4 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  assert.equal((await store.get<any>("proposals", "negative")).status, "refused");
  assert.equal(mutationsRun, 0);
});

test("with farm_ids empty, only a farm that collect read can be written to", async () => {
  const OPEN: any = { ...S, farm_ids: [] };
  const t = NOW.getTime() - HOUR;
  const unread = { kind: "rainfall", farm_id: "FARM2", sensor_id: "GAUGE-1", value: 5, time: t };
  const read = { kind: "rainfall", farm_id: "FARM1", sensor_id: "GAUGE-1", value: 5, time: t };

  const before = new MemoryStore();
  await before.put("proposals", "p1", read);
  assert.deepEqual(await queueRecords(context(WF, OPEN, before, NOW, () => {})), { queued: 0, refused: 1 }, "collect has not run, so nothing is writable");

  const store = new MemoryStore(), ctx = context(WF, OPEN, store, NOW, () => {});
  await collect(ctx);
  await store.put("proposals", "p-read", read);
  await store.put("proposals", "p-unread", unread);
  assert.deepEqual(await queueRecords(ctx), { queued: 1, refused: 1 });
  assert.equal((await store.get<any>("proposals", "p-unread")).reason, "farm was not read by collect");
  assert.equal(mutationsRun, 0);
});

test("a write cannot be drafted and a read cannot be queued", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "agriwebb", op: "mutation.addRainfalls", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "agriwebb", op: "query.fields", summary: "x" }), /not a live operation/);
  assert.equal(mutationsRun, 0);
});
