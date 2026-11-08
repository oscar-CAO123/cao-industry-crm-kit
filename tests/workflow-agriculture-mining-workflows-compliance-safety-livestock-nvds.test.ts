// Livestock NVD workflow tests. Every request goes to a fake network: no test reaches a real AgriWebb account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { stockRegister, nvdDraft } from "../industries/agriculture-mining/workflows/compliance-safety/livestock-nvds/index.ts";

const DIR = "industries/agriculture-mining/workflows/compliance-safety/livestock-nvds";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const S: any = { business_name: "Test Station", farm_id: "FARM1", max_pages: 3 };
const NOW = new Date("2026-11-09T00:00:00Z");
const ANIMALS = [
  { animalId: "a1", managementGroupId: "G1", identity: { name: "Cow 1", eid: "982000100000001", vid: "V1", managementTag: "M-01" } },
  { animalId: "a2", managementGroupId: "G1", identity: { name: "Cow 2", eid: "982000100000002", vid: null, managementTag: null } },
  { animalId: "a3", managementGroupId: "G2", identity: { name: "Ewe 3", eid: null, vid: "V3", managementTag: "M-03" } },
];
const GROUPS = [{ managementGroupId: "G1", name: "Breeders", species: "cattle", type: "mob" }, { managementGroupId: "G2", name: "Ewes", species: "sheep", type: "mob" }];

let calls: { query: string; variables: any }[] = [];
let mutationsRun = 0;

function fake() {
  calls = []; mutationsRun = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (_url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const q = String(body.query ?? "");
      calls.push({ query: q, variables: body.variables });
      const json = (d: unknown) => new Response(JSON.stringify({ data: d }), { status: 200, headers: { "content-type": "application/json" } });
      if (/^mutation/.test(q)) { mutationsRun++; return json({ addRecords: { records: [] } }); }
      if (/managementGroups\(/.test(q)) return json({ managementGroups: GROUPS });
      if (/animals\(/.test(q)) {
        const skip = Number(body.variables?.skip ?? 0), limit = Number(body.variables?.limit ?? 100);
        return json({ animals: ANIMALS.slice(skip, skip + limit) });
      }
      return new Response("not faked: " + q.slice(0, 80), { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake();
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { AGRIWEBB_ACCESS_TOKEN: "test-token", KIT_ALLOW_WRITES: "1" });
});

test("crons read AgriWebb, never write, and match tags into drafts or needs-check", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await store.put("nvd-requests", "req-1", { id: "req-1", tags: ["982000100000001", "M-03"], status: "new" });
  await store.put("nvd-requests", "req-2", { id: "req-2", tags: ["982000100000001", "NOPE-99"], status: "new" });
  await store.put("nvd-requests", "req-3", { id: "req-3", tags: [], status: "new" });

  const reg = await stockRegister(ctx);
  assert.deepEqual(reg, { animals: 3, groups: 2 });
  const drafts = await nvdDraft(ctx);
  assert.deepEqual(drafts, { drafted: 1, needs_check: 2 });

  assert.equal(mutationsRun, 0, "no cron runs a write");
  assert.ok(calls.length > 0 && calls.every((c) => /^query/.test(c.query)), "every cron call is a query");

  const r1 = await store.get<any>("nvd-requests", "req-1");
  assert.equal(r1.status, "drafted");
  assert.equal(r1.lines[0].animal_id, "a1");
  assert.equal(r1.lines[1].animal_id, "a3");
  assert.equal((await store.get<any>("nvd-requests", "req-2")).status, "needs-check");
  assert.equal((await store.get<any>("nvd-requests", "req-3")).status, "needs-check");
});

test("a mutation cannot run as a draft in this workflow", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(
    ctx.draft({ platform: "agriwebb", op: "mutation.addRecords", input: { params: { input: { farmId: "FARM1", records: [] } } }, summary: "x" }),
    /not a draft operation/,
  );
  assert.equal(mutationsRun, 0);
});

test("a write is only queued, runs once on approval, and a re-queue never duplicates", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  const act = { platform: "agriwebb", op: "mutation.addRecords", key: "move-1", summary: "movement record",
    input: { params: { input: { farmId: "FARM1", records: [] } } } };
  const id1 = await ctx.queue(act);
  const id2 = await ctx.queue(act);
  assert.equal(id1, id2, "a second queue of the same key returns the same approval");
  assert.equal(mutationsRun, 0, "queuing does not run the write");
  assert.equal((await store.get<Approval>("approvals", id1))?.status, "pending");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);

  const ap = await approve(WF, store, id1, "oscar", NOW);
  assert.equal(ap.status, "done");
  assert.equal(mutationsRun, 1, "the approved write runs exactly once");
});
