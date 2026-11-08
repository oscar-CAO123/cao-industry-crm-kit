// Carbon-credits workflow tests. Every request goes to a fake network: no test reaches a real AgriWebb account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { snapshot, checklist } from "../industries/agriculture-mining/workflows/compliance-safety/carbon-credits/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/agriculture-mining/workflows/compliance-safety/carbon-credits/workflow.json", "utf8")) as WorkflowRecord;
const SETTINGS = { farms: ["FARM1"] };
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { host: string; method: string; query: string };
let hits: Hit[] = [];
let failFields = false;

const ROWS: Record<string, unknown[]> = {
  farms: [{ id: "FARM1", name: "Test Station", timeZone: "Australia/Sydney" }],
  fields: [
    { id: "F1", name: "North", farmId: "FARM1", totalArea: 40.5, unit: "HECTARES", landUse: "GRAZING", cropType: null },
    { id: "F2", name: "Other farm", farmId: "FARM2", totalArea: 10, unit: "HECTARES", landUse: "GRAZING" },
  ],
  records: [{ __typename: "ObservationRecord" }, { __typename: "WeighRecord" }],
};

function fake() {
  hits = [];
  failFields = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url));
      let body: any = {};
      try { body = init?.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
      const query = String(body.query ?? "");
      hits.push({ host: u.hostname, method: init?.method ?? "GET", query });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.hostname !== "api.agriwebb.com") return new Response("not faked: " + u.hostname, { status: 404 });
      const field = /\{\s*(\w+)/.exec(query.replace(/^(query|mutation) Kit(\([^)]*\))?/, ""))?.[1] ?? "";
      if (field === "fields" && failFields) return json({ errors: [{ message: "scope denied" }] });
      return json({ data: { [field]: ROWS[field] ?? [] } });
    }) as any,
  });
}

const ctxFor = (settings: any = SETTINGS) => {
  const store = new MemoryStore();
  return { store, ctx: context(WF, settings, store, NOW, () => {}) };
};

beforeEach(() => {
  fake();
  setTokenStore(new MemoryTokenStore());
  process.env.AGRIWEBB_ACCESS_TOKEN = "test-token-not-real";
});

test("snapshot reads the farm, its fields and its records, and sends only GraphQL queries", async () => {
  const { store, ctx } = ctxFor();
  assert.deepEqual(await snapshot(ctx), { farms: 1 });
  const snap = await store.get<any>("evidence", "latest");
  assert.equal(snap.farms[0].name, "Test Station");
  assert.deepEqual(snap.farms[0].fields.map((f: any) => f.id), ["F1"]); // F2 belongs to another farm
  assert.equal(snap.farms[0].records_count, 2);
  assert.ok(hits.every((h) => h.method === "POST" && h.query.startsWith("query Kit")), "a cron sent something other than a GraphQL query");
  for (const f of ["farms", "fields", "records"]) assert.ok(hits.some((h) => new RegExp(`\\{ ${f}\\b`).test(h.query)), `no ${f} read`);
});

test("a second snapshot replaces the evidence and again sends only reads", async () => {
  const { store, ctx } = ctxFor();
  await snapshot(ctx);
  const first = hits.length;
  await snapshot(ctx);
  assert.equal(hits.length, first * 2);
  assert.ok(hits.every((h) => h.query.startsWith("query Kit")));
  assert.equal(Object.keys(await store.list("evidence")).length, 1);
});

test("checklist drafts from the stored snapshot without any network call", async () => {
  const { store, ctx } = ctxFor();
  await snapshot(ctx);
  hits = [];
  assert.deepEqual(await checklist(ctx), { drafted: 1 });
  assert.equal(hits.length, 0);
  const d = await store.get<any>("drafts", "carbon-checklist");
  const byItem = Object.fromEntries(d.farms[0].items.map((i: any) => [i.item, i.status]));
  assert.deepEqual(byItem, {
    "Farm profile": "on file",
    "Field boundaries and areas": "on file",
    "Land use per field": "on file",
    "Farm records in the system": "on file",
  });
});

test("checklist with no snapshot drafts nothing", async () => {
  const { ctx } = ctxFor();
  assert.deepEqual(await checklist(ctx), { drafted: 0, reason: "no snapshot yet" });
});

test("a write cannot be drafted by a cron and cannot be queued as a live action", async () => {
  const { ctx } = ctxFor();
  await assert.rejects(ctx.draft({ platform: "agriwebb", op: "mutation.addRecords", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "agriwebb", op: "query.farms", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("a farm id that is not a plain id is refused before any call", async () => {
  const { ctx } = ctxFor({ farms: ["FARM1; drop"] });
  await assert.rejects(snapshot(ctx), /bad farm id/);
  assert.equal(hits.length, 0);
});

test("a GraphQL error is raised and nothing is stored", async () => {
  failFields = true;
  const { store, ctx } = ctxFor();
  await assert.rejects(snapshot(ctx), /agriwebb fields: scope denied/);
  assert.equal(await store.get("evidence", "latest"), undefined);
});
