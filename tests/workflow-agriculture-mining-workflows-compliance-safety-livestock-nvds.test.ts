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

let ANIMALS_OVERRIDE: any[] | undefined;   // a test can replace the farm's animal list
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
        const list = ANIMALS_OVERRIDE ?? ANIMALS;
        return json({ animals: list.slice(skip, skip + limit) });
      }
      return new Response("not faked: " + q.slice(0, 80), { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake();
  ANIMALS_OVERRIDE = undefined;
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

test("a tag on two different animals is ambiguous, so its NVD line needs a check", async () => {
  const store = new MemoryStore();
  await store.put("stock", "x1", { key: "x1", animal_id: "x1", eid: "DUP-1", read: "2026-11-01T00:00:00Z" });
  await store.put("stock", "x2", { key: "x2", animal_id: "x2", eid: "DUP-1", read: "2026-11-01T00:00:00Z" });
  await store.put("nvd-requests", "req-d", { id: "req-d", tags: ["DUP-1"], status: "new" });
  assert.deepEqual(await nvdDraft(context(WF, S, store, NOW, () => {})), { drafted: 0, needs_check: 1 });
  const r = await store.get<any>("nvd-requests", "req-d");
  assert.equal(r.status, "needs-check");
  assert.equal(r.lines[0].matched, false);
  assert.equal(r.lines[0].ambiguous, true);
  assert.equal(r.lines[0].animal_id, undefined, "neither animal is picked");
});

test("an animal a complete read no longer lists is marked gone and its tag does not match", async () => {
  const store = new MemoryStore();
  await store.put("stock", "gone-1", { key: "gone-1", animal_id: "gone-1", eid: "982000999000001", read: "2026-11-01T00:00:00Z" });
  await store.put("nvd-requests", "req-g", { id: "req-g", tags: ["982000999000001"], status: "new" });
  await stockRegister(context(WF, S, store, NOW, () => {}));
  assert.ok((await store.get<any>("stock", "gone-1")).gone, "sold or dead animal is marked gone");
  assert.equal((await store.get<any>("stock", "a1"))?.gone, undefined, "animals still listed are not marked");
  await nvdDraft(context(WF, S, store, NOW, () => {}));
  assert.equal((await store.get<any>("nvd-requests", "req-g")).status, "needs-check");
});

test("a capped animal read marks nothing gone", async () => {
  ANIMALS_OVERRIDE = Array.from({ length: 100 }, (_, i) => ({ animalId: `b${i}`, managementGroupId: "G1",
    identity: { name: `B${i}`, eid: `98200020${String(i).padStart(4, "0")}`, vid: null, managementTag: null } }));
  const store = new MemoryStore();
  await store.put("stock", "gone-2", { key: "gone-2", animal_id: "gone-2", eid: "982000888000001", read: "2026-11-01T00:00:00Z" });
  await stockRegister(context(WF, { ...S, max_pages: 1 }, store, NOW, () => {}));
  assert.equal((await store.get<any>("stock", "gone-2"))?.gone, undefined, "one page of 100 is not the whole farm");
});
