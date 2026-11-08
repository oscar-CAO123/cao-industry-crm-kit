// Pipeline-advance workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval, type Act } from "../core/workflows/runtime.ts";
import { scan, queue } from "../industries/all/workflows/sales/pipeline-advance/index.ts";
import type { Move, Settings } from "../industries/all/workflows/sales/pipeline-advance/types.ts";

const WF_DIR = "industries/all/workflows/sales/pipeline-advance";
const WF = JSON.parse(fs.readFileSync(`${WF_DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");

// GoHighLevel fixture. stage-a is the first stage, stage-c the last. opp1 is stalled (last change 68 days ago).
type Opp = { id: string; name: string; pipelineStageId: string; status: string; lastActionDate?: string; lastStageChangeAt?: string };
let ghl: Record<string, Opp>;
const GHL_FRESH = "2026-11-07T10:00:00.000Z", GHL_OLD = "2026-09-01T00:00:00.000Z";
function resetGhl() {
  ghl = {
    opp1: { id: "opp1", name: "Acme roof repair", pipelineStageId: "stage-b", status: "open", lastActionDate: GHL_OLD, lastStageChangeAt: GHL_OLD },
    opp2: { id: "opp2", name: "Harbour fit-out", pipelineStageId: "stage-a", status: "open", lastActionDate: GHL_FRESH },
    opp3: { id: "opp3", name: "Pool fence", pipelineStageId: "stage-b", status: "open", lastActionDate: GHL_FRESH },
    opp4: { id: "opp4", name: "Lost lead", pipelineStageId: "stage-b", status: "lost", lastActionDate: GHL_OLD },
  };
}

// Pipedrive fixture. Stage ids are digits; stage 1 is first.
const PD_OLD = "2026-09-01 10:00:00", PD_FRESH = "2026-11-07 09:00:00";

let hits: { method: string; host: string; path: string; query: string; body: any }[] = [];
let pdCursorSeen: string | null = null;

function fake() {
  hits = []; pdCursorSeen = null; resetGhl();
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, host: u.host, path: p, query: u.search, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // GoHighLevel
      if (u.host === "services.leadconnectorhq.com") {
        if (p === "/opportunities/search" && m === "GET") {
          if (u.searchParams.get("startAfterId")) return json({ opportunities: [ghl.opp3], meta: { total: 3 } });
          return json({ opportunities: [ghl.opp1, ghl.opp2], meta: { total: 3, startAfter: 1, startAfterId: "opp2" } });
        }
        const one = /^\/opportunities\/([A-Za-z0-9_-]+)$/.exec(p);
        if (one && m === "GET") return ghl[one[1]] ? json({ opportunity: ghl[one[1]] }) : new Response("{}", { status: 404 });
        if (one && m === "PUT") {
          const o = ghl[one[1]];
          if (body?.pipelineStageId) o.pipelineStageId = body.pipelineStageId;
          return json({ opportunity: o });
        }
      }
      // Pipedrive
      if (u.host === "api.pipedrive.com") {
        if (p === "/api/v2/deals" && m === "GET") {
          const c = u.searchParams.get("cursor"); pdCursorSeen = c;
          if (!c) return json({ data: [{ id: 11, title: "Coastal deck", stage_id: 1, status: "open", update_time: PD_OLD, add_time: "2026-08-01 09:00:00" }],
                                additional_data: { next_cursor: "c2" } });
          return json({ data: [{ id: 12, title: "Garden wall", stage_id: 1, status: "open", update_time: PD_FRESH, add_time: "2026-10-01 09:00:00" }], additional_data: {} });
        }
        if (p === "/api/v2/deals/11" && m === "GET") return json({ data: { id: 11, title: "Coastal deck", stage_id: 1, status: "open", update_time: PD_OLD } });
        if (p === "/api/v2/deals/11" && m === "PATCH") return json({ data: { id: 11, stage_id: body?.stage_id } });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const writes = () => hits.filter((h) => h.method !== "GET");
const GHL_SETTINGS: Settings = { platform: "gohighlevel", location_id: "LOC1", pipeline_id: "pipe-1",
  stage_order: ["stage-a", "stage-b", "stage-c"], stale_after_days: 14, read_limit: 500 };
const PD_SETTINGS: Settings = { platform: "pipedrive", pipeline_id: "7", stage_order: ["1", "2", "3"], stale_after_days: 14, read_limit: 500 };

const move = (deal: string, to: string, why = "Quote sent on 6 Nov, client asked for a site visit"): Move => ({ deal, to, why, at: NOW.toISOString(), status: "pending" });

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { GHL_ACCESS_TOKEN: "test-ghl-token", PIPEDRIVE_API_TOKEN: "test-pd-token", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a queue cannot run a read", async () => {
  const ctx = context(WF, GHL_SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "gohighlevel", op: "opportunities.update-opportunity", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "gohighlevel", op: "opportunities.search-opportunity", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.queue({ platform: "pipedrive", op: "openapi-v2.getDeal", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("scan: reads every page, drafts the stalled register, and writes nothing to the CRM", async () => {
  const store = new MemoryStore();
  const out = await scan(context(WF, GHL_SETTINGS, store, NOW, () => {}));
  assert.deepEqual(out, { read: 3, stalled: 1, added: 1, resolved: 0, truncated: false });
  assert.equal(writes().length, 0, "a scan never writes");
  const findings = await store.list<any>("findings");
  assert.deepEqual(Object.keys(findings), ["stalled:gohighlevel:opp1"]);
  assert.equal(findings["stalled:gohighlevel:opp1"].status, "open");
  assert.match(findings["stalled:gohighlevel:opp1"].summary, /Acme roof repair: \d+ days with no recorded change, in stage stage-b/);
});

test("scan: a deal that changes again is resolved on the next full read", async () => {
  const store = new MemoryStore();
  await scan(context(WF, GHL_SETTINGS, store, NOW, () => {}));
  ghl.opp1.lastActionDate = "2026-11-06T00:00:00.000Z";
  ghl.opp1.lastStageChangeAt = "2026-11-06T00:00:00.000Z";
  const out = await scan(context(WF, GHL_SETTINGS, store, NOW, () => {}));
  assert.equal(out.resolved, 1);
  assert.equal((await store.get<any>("findings", "stalled:gohighlevel:opp1"))!.status, "resolved");
});

test("a recorded stage move is queued for approval, never sent by a cron, and a re-run queues it once", async () => {
  const store = new MemoryStore(), ctx = context(WF, GHL_SETTINGS, store, NOW, () => {});
  await store.put("moves", "opp1", move("opp1", "stage-c"));
  assert.deepEqual(await queue(ctx), { queued: 1, skipped: 0 });
  assert.equal(writes().length, 0, "nothing changed by a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.match(pending[0].summary, /Move Acme roof repair from stage stage-b to stage-c: Quote sent on 6 Nov/);
  assert.deepEqual(await queue(ctx), { queued: 0, skipped: 0 }, "a queued move is not picked up again");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
  assert.equal((await store.get<Move>("moves", "opp1"))!.status, "queued");
});

test("approval runs the stage change with the pipeline and stage ids, and a second approve is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, GHL_SETTINGS, store, NOW, () => {});
  await store.put("moves", "opp1", move("opp1", "stage-c"));
  await queue(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const put = hits.find((h) => h.method === "PUT")!;
  assert.equal(put.path, "/opportunities/opp1");
  assert.deepEqual(put.body, { pipelineId: "pipe-1", pipelineStageId: "stage-c" });
  assert.equal(ghl.opp1.pipelineStageId, "stage-c");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(writes().length, 1, "the stage changed once");
});

test("moves that go backward, stay put, name an unknown stage, or land on a lost deal are skipped", async () => {
  const store = new MemoryStore(), ctx = context(WF, GHL_SETTINGS, store, NOW, () => {});
  await store.put("moves", "opp1", move("opp1", "stage-a"));              // backward from stage-b
  await store.put("moves", "opp2", move("opp2", "stage-a"));              // stays at stage-a
  await store.put("moves", "opp3", move("opp3", "stage-z"));              // not in stage_order
  await store.put("moves", "opp4", move("opp4", "stage-c"));              // deal is lost
  assert.deepEqual(await queue(ctx), { queued: 0, skipped: 4 });
  assert.equal((await store.get<Move>("moves", "opp1"))!.reason, "the move goes backward or stays where it is");
  assert.equal((await store.get<Move>("moves", "opp2"))!.reason, "the move goes backward or stays where it is");
  assert.equal((await store.get<Move>("moves", "opp3"))!.reason, "the target stage is not in stage_order");
  assert.equal((await store.get<Move>("moves", "opp4"))!.reason, "deal is lost, not open");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.equal(writes().length, 0);
});

test("Pipedrive: pages through open deals, queues a move, and approval sends stage_id as a number", async () => {
  const store = new MemoryStore();
  const out = await scan(context(WF, PD_SETTINGS, store, NOW, () => {}));
  assert.equal(pdCursorSeen, "c2", "the second page was read");
  assert.deepEqual(out, { read: 2, stalled: 1, added: 1, resolved: 0, truncated: false });
  assert.equal(writes().length, 0);
  await store.put("moves", "11", { deal: "11", to: "2", why: "Site visit held on 5 Nov, quote requested", at: NOW.toISOString(), status: "pending" });
  const ctx = context(WF, PD_SETTINGS, store, NOW, () => {});
  assert.deepEqual(await queue(ctx), { queued: 1, skipped: 0 });
  assert.equal(writes().length, 0, "queued, not sent");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  const patch = hits.find((h) => h.method === "PATCH")!;
  assert.equal(patch.path, "/api/v2/deals/11");
  assert.deepEqual(patch.body, { stage_id: 2 });
});

test("a bad cursor or bad settings are refused before any call", async () => {
  await assert.rejects(scan(context(WF, { ...GHL_SETTINGS, stage_order: ["stage-a", "stage-a"] }, new MemoryStore(), NOW, () => {})), /repeats a stage/);
  await assert.rejects(scan(context(WF, { ...GHL_SETTINGS, location_id: undefined }, new MemoryStore(), NOW, () => {})), /needs location_id/);
  await assert.rejects(scan(context(WF, { ...PD_SETTINGS, stale_after_days: 0 }, new MemoryStore(), NOW, () => {})), /stale_after_days/);
  assert.equal(hits.length, 0);
});

test("the workflow record lists only reads as draft operations and only the stage update as a live operation", () => {
  const drafts = Object.values(WF.draft_ops).flat(), lives = Object.values(WF.live_ops).flat();
  assert.ok(drafts.every((op) => !/update|send|create|delete|merge|patch|put|post/i.test(op)), "draft ops are reads");
  assert.deepEqual(lives.sort(), ["openapi-v2.updateDeal", "opportunities.update-opportunity"]);
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), ["queue", "scan"]);
  const act: Act = { platform: "pipedrive", op: "openapi-v2.updateDeal", summary: "x" };
  assert.ok(WF.live_ops.pipedrive.includes(act.op));
});
