// Approvals workflow tests. Every request goes to a fake network: no test reaches a real Bluebeam account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { trackStatus, recordKeeping, CRONS } from "../industries/construction/workflows/compliance-safety/approvals/index.ts";
import fs from "node:fs";

const DIR = "industries/construction/workflows/compliance-safety/approvals";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SESSION = "11111111-2222-4333-8444-555555555555";
const S: any = { business_name: "Test Builders", bluebeam: { sessions: [{ session_id: SESSION, file_id: "7", label: "DA set" }] } };
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === `/publicapi/v1/sessions/${SESSION}/files`) return json({ Files: [{ Id: 7, Name: "DA plans.pdf", Status: "Active" }], TotalCount: 1 });
      if (p === `/publicapi/v2/sessions/${SESSION}/files/7/markups`) return json([
        { markupId: "m1", subject: "RFI: council wants a setback drawing", status: "Open", pageNumber: 3 },
        { markupId: "m2", subject: "Drainage note", status: "Closed", pageNumber: 1 }]);
      if (p === `/publicapi/v2/sessions/${SESSION}/files/7/statuses`) return json([{ Model: "Open", State: "Open" }, { Model: "Closed", State: "Closed" }]);
      if (p === `/publicapi/v1/sessions/${SESSION}/files/7/snapshot`) return json({ Id: 99 }, 202);
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { BLUEBEAM_ACCESS_TOKEN: "tok", BLUEBEAM_CLIENT_ID: "cid", KIT_ALLOW_WRITES: "1" });
});

test("track-status reads the open items and records them, with no writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await trackStatus(ctx), { documents: 1, open: 1 });
  assert.equal(writes().length, 0, "nothing written to Bluebeam");
  const rec = (await store.list<any>("approval-status")) as Record<string, any>;
  const one = Object.values(rec)[0];
  assert.equal(one.open, 1);
  assert.equal(one.open_rfis, 1);
  assert.equal(one.statuses_valid, 2);
  assert.equal(one.open_items[0].id, "m1");
});

test("record-keeping snapshots once a day and a re-run the same day never repeats it", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await recordKeeping(ctx), { snapshots: 1, skipped: 0 });
  assert.deepEqual(await recordKeeping(ctx), { snapshots: 0, skipped: 1 });
  assert.equal(writes().length, 1, "one snapshot call in total");
  assert.equal(writes()[0].method, "POST");
  const tomorrow = context(WF, S, store, new Date("2026-11-10T00:00:00Z"), () => {});
  assert.deepEqual(await recordKeeping(tomorrow), { snapshots: 1, skipped: 0 });
});

test("the crons reach only draft operations: a status change or a queued snapshot is refused", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "bluebeam", op: "SessionMarkups_UpdateStatus", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "bluebeam", op: "SessionFiles_Snapshot", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("with writes off, the snapshot is blocked before any socket opens", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(recordKeeping(ctx), WriteBlocked);
  assert.equal(hits.length, 0);
});

test("bad ids in settings are refused before any network call", async () => {
  const bad: any = { bluebeam: { sessions: [{ session_id: "../admin", file_id: "7" }] } };
  const ctx = context(WF, bad, new MemoryStore(), NOW, () => {});
  await assert.rejects(trackStatus(ctx), /bad session id/);
  await assert.rejects(recordKeeping(ctx), /bad session id/);
  assert.equal(hits.length, 0);
});

test("no document configured: the crons do nothing and reach no network", async () => {
  const ctx = context(WF, {}, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await trackStatus(ctx), { documents: 0, open: 0 });
  assert.deepEqual(await recordKeeping(ctx), { snapshots: 0, skipped: 0 });
  assert.equal(hits.length, 0);
});

test("every cron in workflow.json has an export, and the record lists no live operations", () => {
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `missing export for ${c.entry}`);
  assert.deepEqual(Object.values(WF.live_ops).flat(), []);
});
