// Condition-report workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { properties, contacts, CRONS } from "../industries/real-estate/workflows/fulfilment/condition/index.ts";

const DIR = "industries/real-estate/workflows/fulfilment/condition";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const OPS = JSON.parse(fs.readFileSync("core/sdk/platforms/agentbox/ops.json", "utf8")) as { id: string }[];
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET";
      hits.push({ method: m, path: u.pathname });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/properties") return json({ pageNumber: 1, _embedded: [{ id: "OXF18000001" }, { id: "../bad" }] });
      if (u.pathname === "/contacts") return json({ pageNumber: 1, _embedded: [{ id: "OXF18000002", forename: "Jo", surname: "Lee", email: "jo@example.com" }] });
      return new Response("not faked: " + u.pathname, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake();
  setTokenStore(new MemoryTokenStore());
  process.env.REAPIT_ACCESS_TOKEN = "t".repeat(20);
  delete process.env.KIT_ALLOW_WRITES;
});

test("every draft op is a mapped AgentBox operation, every cron entry is exported, and no live op is listed", () => {
  const ids = new Set(OPS.map((o) => o.id));
  for (const op of WF.draft_ops.agentbox) assert.ok(ids.has(op), `${op} is mapped`);
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `${c.entry} exported`);
  assert.deepEqual(WF.live_ops.agentbox, []);
});

test("crons only read: every request that reaches the network is a GET", async () => {
  const store = new MemoryStore(), ctx = context(WF, {}, store, NOW, () => {});
  await properties(ctx);
  await contacts(ctx);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.method === "GET"), "no write");
});

test("a cron keeps only valid ids and stores no more than id, name and time; a re-run does not duplicate", async () => {
  const store = new MemoryStore(), ctx = context(WF, {}, store, NOW, () => {});
  assert.deepEqual(await properties(ctx), { read: 1 }, "the hostile id is dropped");
  await contacts(ctx);
  await properties(ctx);
  await contacts(ctx);
  assert.deepEqual(Object.keys(await store.list("properties")), ["OXF18000001"]);
  const c = (await store.get<Record<string, unknown>>("contacts", "OXF18000002"))!;
  assert.deepEqual(Object.keys(c).sort(), ["id", "name", "seen"]);
  assert.equal(c.name, "Jo Lee");
});

test("a write cannot run as a draft or be queued, even when mapped in the kit", async () => {
  const ctx = context(WF, {}, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "agentbox", op: "post:/documents", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "agentbox", op: "post:/documents", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});
