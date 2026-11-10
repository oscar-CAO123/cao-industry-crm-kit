// Mass compliance workflow tests. Every request goes to a fake network: no test reaches a real Trackunit account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { register, massCheck, CRONS } from "../industries/transport/workflows/compliance-safety/mass-compliance/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/transport/workflows/compliance-safety/mass-compliance/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const S: any = { family: "general", business_name: "Test Transport" };
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];

/** 103 vehicles on two pages. Vehicle 2 has no brand or model; vehicle 51 has no production year. */
function fleet(): any[] {
  const f = Array.from({ length: 103 }, (_, i) => ({
    id: uid(i + 1), name: `Truck ${i + 1}`, assetType: "VEHICLE", type: "Rigid", brand: "Brand", model: "Model",
    serialNumber: `SN${i + 1}`, productionYear: 2022, createdAt: "2026-01-01T00:00:00Z",
  }));
  delete f[1].brand; delete f[1].model;
  delete f[50].productionYear;
  return f;
}

function fake(assets: any[]) {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/api/asset/v2/assets" && m === "GET") {
        const page = Number(u.searchParams.get("page") ?? 0), size = Number(u.searchParams.get("size") ?? 100);
        const content = assets.slice(page * size, page * size + size);
        return json({ content, number: page, numberOfElements: content.length, size, totalElements: assets.length, totalPages: Math.ceil(assets.length / size) });
      }
      if (p === "/api/asset/v2/assets/note" && m === "PATCH") return json({});
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(fleet()); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { TRACKUNIT_ACCESS_TOKEN: "tok", KIT_ALLOW_WRITES: "1" });
});

test("register reads every page of the vehicle register and writes nothing", async () => {
  const store = new MemoryStore();
  const r = await register(context(WF, S, store, NOW, () => {}));
  assert.equal(r.vehicles, 103);
  assert.equal(hits.filter((h) => h.method === "GET" && h.path === "/api/asset/v2/assets").length, 2);
  assert.equal(writes().length, 0);
  assert.equal(Object.keys(await store.list("vehicles")).length, 103);
});

test("mass-check queues one note per vehicle with a gap and never writes to Trackunit", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await register(ctx);
  const r = await massCheck(ctx);
  assert.deepEqual(r, { flagged: 2, clear: 101 });
  assert.equal(writes().length, 0);
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((a) => a.status === "pending"));
});

test("running mass-check again does not queue the same note twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await register(ctx);
  await massCheck(ctx);
  await massCheck(ctx);
  assert.equal(Object.keys(await store.list("approvals")).length, 2);
});

test("an approved note runs once, against the right vehicle, with the note text", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await register(ctx);
  await massCheck(ctx);
  const pending = Object.values(await store.list<Approval>("approvals"));
  const forTwo = pending.find((a) => a.acts[0].input?.body?.identifier?.value === uid(2));
  assert.ok(forTwo, "a note is queued for vehicle 2");
  const done = await approve(WF, store, forTwo!.id, "owner", NOW);
  assert.equal(done.status, "done");
  const patch = writes();
  assert.equal(patch.length, 1);
  assert.equal(patch[0].path, "/api/asset/v2/assets/note");
  assert.deepEqual(patch[0].body.identifier, { type: "ASSET_ID", value: uid(2) });
  assert.match(patch[0].body.note, /missing brand, model/);
});

test("the approval says the note will be overwritten and shows the text that replaces it", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await register(ctx);
  await massCheck(ctx);
  const forTwo = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].input?.body?.identifier?.value === uid(2))!;
  assert.match(forTwo.summary, /overwrites the note/);
  assert.ok(forTwo.summary.includes("missing brand, model"), "the summary shows the new note text");
});

test("a draft cannot run the note operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(
    ctx.draft({ platform: "trackunit", op: "assets.updateAssetNote_v2", summary: "try", input: { body: {} } }),
    /not a draft operation/,
  );
});

test("every cron in the workflow record has an entry point", () => {
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `missing entry ${c.entry}`);
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});
