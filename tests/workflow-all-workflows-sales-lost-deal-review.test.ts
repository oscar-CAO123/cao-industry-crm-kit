// Lost-deal review workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, review, rollup } from "../industries/all/workflows/sales/lost-deal-review/index.ts";
import { keyOf } from "../industries/all/workflows/sales/lost-deal-review/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/lost-deal-review/workflow.json", "utf8")) as WorkflowRecord;
const LOC = "LOCATION0000000001", PRICE = "REASONPRICE01", TIMING = "REASONTIME0001";
const OPP_A = "OPPLOST0000000001", OPP_B = "OPPLOST0000000002", OPP_WON = "OPPWON00000000001";
const SETTINGS: any = { business_name: "Test Builders", locationId: LOC, nurture_reason_ids: [PRICE], nurture_within_days: 90, rollup_days: 90 };
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let lostList: any[] = [];
let liveFix: Record<string, Record<string, unknown>> = {};

const lostA = () => ({ id: OPP_A, name: "Smith <b>demolition</b>", monetaryValue: 42000, status: "lost", lostReasonId: PRICE, lastStatusChangeAt: "2026-11-01T00:00:00Z", pipelineId: "PIPELINE000000001" });
const lostB = () => ({ id: OPP_B, name: "Old enquiry", monetaryValue: 1000, status: "lost", lastStatusChangeAt: "2025-01-01T00:00:00Z" });
const wonC = () => ({ id: OPP_WON, name: "Won job", monetaryValue: 5000, status: "won", lastStatusChangeAt: "2026-10-20T00:00:00Z" });

function fake() {
  hits = []; liveFix = {}; lostList = [lostA(), lostB()];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/opportunities/lost-reason") && m === "GET") return json({ lostReasons: [{ id: PRICE, name: "Price too high" }, { id: TIMING, name: "Timing" }], total: 2 });
      if (p.endsWith("/opportunities/search") && m === "GET") {
        const status = u.searchParams.get("status");
        const items = status === "lost" ? lostList : status === "won" ? [wonC()] : [];
        return json({ opportunities: items, meta: { nextPage: null, total: items.length } });
      }
      const one = /^\/opportunities\/([A-Za-z0-9]+)$/.exec(p);
      if (one && m === "GET") { const rec = [...lostList, wonC()].find((o) => o.id === one[1]); return rec ? json({ opportunity: { ...rec, ...liveFix[one[1]] } }) : new Response("{}", { status: 404 }); }
      if (/\/opportunities\/[^/]+\/status$/.test(p) && m === "PUT") return json({ succeeded: true });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { GHL_ACCESS_TOKEN: "ghl-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run the live re-open as a draft, and cannot queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "gohighlevel", op: "opportunities.update-opportunity-status", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "gohighlevel", op: "opportunities.search-opportunity", summary: "x" }), /not a live operation/);
});

test("intake reads lost deals and reasons, and marks a deal gone once it is no longer lost", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { lost: 2, added: 2 });
  assert.equal(writes().length, 0, "intake writes nothing to the platform");
  const reasons = await store.get<Record<string, string>>("reasons", "current");
  assert.equal(reasons?.[PRICE], "Price too high");
  const a = await store.get<any>("lost-deals", keyOf(OPP_A));
  assert.equal(a.name, "Smith <b>demolition</b>", "customer text is kept as data, clipped to 120 characters, and escaped only where it reaches HTML");
  lostList = [lostB()];
  assert.deepEqual(await intake(ctx), { lost: 1, added: 0 });
  assert.ok((await store.get<any>("lost-deals", keyOf(OPP_A))).gone, "a deal no longer lost is marked gone, not deleted");
});

test("review drafts one record per lost deal, once, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await review(ctx), { drafted: 2, reopen_pending: 1 });
  assert.deepEqual(await review(ctx), { drafted: 0, reopen_pending: 1 }, "re-runs draft nothing new");
  const rv = await store.get<any>("reviews", keyOf(OPP_A));
  assert.equal(rv.reason, "Price too high");
  assert.equal((await store.get<any>("reviews", keyOf(OPP_B))).reason, "no reason recorded");
  assert.equal(writes().length, 0, "no status change reached the platform");
});

const reads = () => hits.filter((h) => h.method === "GET" && h.path === `/opportunities/${OPP_A}`);

test("a nurture re-open is only queued, approved by a person, and never run twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await review(ctx); await review(ctx);
  assert.equal(writes().length, 0, "a cron never re-opens a deal");
  const pending = await store.list<Approval>("approvals");
  assert.equal(Object.keys(pending).length, 1, "re-runs never queue the same re-open twice");
  const id = Object.keys(pending)[0];
  assert.equal(pending[id].status, "pending");
  assert.match(pending[id].summary, /Re-open lost deal Smith <b>demolition<\/b> \(value \$42,000\)/);
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(reads().length, 1, "the deal was re-read just before the re-open");
  const put = writes().find((h) => h.method === "PUT")!;
  assert.equal(put.path, `/opportunities/${OPP_A}/status`);
  assert.deepEqual(put.body, { status: "open" });
  await assert.rejects(approve(WF, store, id, "owner"), /already done/);
});

test("a re-open sends nothing when the deal was won after it was queued, and the approval is closed", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await review(ctx);
  const id = Object.keys(await store.list<Approval>("approvals"))[0];
  liveFix[OPP_A] = { status: "won" };
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "rejected");
  assert.equal(ap.decided_by, "check");
  assert.match(ap.error ?? "", /the record changed after this was queued .*nothing was sent/);
  assert.equal(writes().length, 0, "no status change reached the platform");
});

test("a closed re-open is queued again only once the deal is lost again, and never twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await review(ctx);
  const first = Object.keys(await store.list<Approval>("approvals"))[0];
  liveFix[OPP_A] = { lostReasonId: TIMING };
  assert.equal((await approve(WF, store, first, "owner", NOW)).status, "rejected");
  liveFix = {};
  lostList = [{ ...lostA(), lastStatusChangeAt: "2026-11-07T00:00:00Z" }, lostB()];
  await intake(ctx); await review(ctx); await review(ctx);
  const all = await store.list<Approval>("approvals");
  const open = Object.values(all).filter((a) => a.status === "pending");
  assert.equal(open.length, 1, "one fresh approval, not one per run");
  assert.notEqual(open[0].id, first);
  assert.equal(all[first].status, "rejected", "the closed approval stays closed");
  assert.equal(writes().length, 0);
});

test("a deal lost to another reason, or lost outside the window, is not queued for re-open", async () => {
  lostList = [{ ...lostA(), lostReasonId: TIMING }, { ...lostB(), lostReasonId: PRICE }];
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await review(ctx), { drafted: 2, reopen_pending: 0 }, "the old price loss is outside 90 days");
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("rollup counts lost and won deals in the window and ranks the lost reasons", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  const r = await rollup(ctx);
  assert.equal(r.lost, 1, "the 2025 loss is outside the 90-day window");
  assert.equal(r.won, 1);
  assert.equal(r.lost_value, 42000);
  assert.equal(r.win_rate, 50);
  assert.deepEqual(r.top_reasons, [{ reason: "Price too high", count: 1, value: 42000 }]);
  assert.equal(r.no_reason, 0);
  assert.deepEqual(await store.get("rollups", "2026-11-08"), r);
  assert.equal(writes().length, 0, "the roll-up is a draft in the store only");
});

test("a bad location id is refused before any request is made", async () => {
  const ctx = context(WF, { ...SETTINGS, locationId: "../etc" }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /bad location id/);
  assert.equal(hits.length, 0);
});

test("crons are exported under their entry names", async () => {
  const { CRONS } = await import("../industries/all/workflows/sales/lost-deal-review/index.ts");
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});
