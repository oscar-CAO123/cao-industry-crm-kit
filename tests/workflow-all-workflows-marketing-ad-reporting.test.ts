// Ad-reporting workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pull, review } from "../industries/all/workflows/marketing/ad-reporting/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/marketing/ad-reporting";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const ACCT = "act_123456789";
const NOW = new Date("2026-11-08T21:00:00Z");

type Hit = { method: string; path: string; search: URLSearchParams; body: any };
let hits: Hit[] = [];
let insightRows: any[] = [];
let activeIds: string[] = [];

function fake() {
  hits = []; activeIds = ["1001", "1002", "1003"];
  insightRows = [
    { ad_id: "1001", ad_name: "Hook A", campaign_id: "9001", campaign_name: "Prospecting", spend: "150.00", impressions: "5000", clicks: "120", actions: [{ action_type: "lead", value: "2" }] },
    { ad_id: "1002", ad_name: "Hook B", campaign_id: "9001", campaign_name: "Prospecting", spend: "90.00", impressions: "900", clicks: "10", actions: [] },
    { ad_id: "1003", ad_name: "Hook C", campaign_id: "9002", campaign_name: "Retargeting", spend: "200.00", impressions: "8000", clicks: "300", actions: [{ action_type: "lead", value: "5" }] },
    { ad_id: "1004", ad_name: "Old ad", campaign_id: "9002", campaign_name: "Retargeting", spend: "300.00", impressions: "9000", clicks: "200", actions: [] },
    { ad_id: "../x", ad_name: "Bad id", campaign_id: "9002", campaign_name: "Retargeting", spend: "10", impressions: "1", clicks: "1", actions: [] },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith(`/${ACCT}/insights`) && m === "GET") return json({ data: insightRows });
      if (p.endsWith(`/${ACCT}/ads`) && m === "GET") return json({ data: activeIds.map((id) => ({ id })) });
      if (/\/\d+$/.test(p) && m === "POST") return json({ success: true });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const posts = () => hits.filter((h) => h.method === "POST");
const SET: any = { business_name: "Test Co", currency: "AUD", meta: { ad_account_id: ACCT }, max_cost_per_lead: 60, min_spend_before_judging: 100, pauses_per_run: 10 };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { META_ADS_TOKEN: "test-token-not-real", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a pause directly and cannot queue a read", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "Ad.post.self", input: { params: { "Ad-id": "1001", status: "PAUSED" } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "meta-ads", op: "AdAccount.get.insights", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("pull reads spend, leads and running ads, keeps one snapshot, and posts nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  const r = await pull(ctx);
  assert.equal(posts().length, 0, "no write by a cron");
  const ins = hits.find((h) => h.path.endsWith(`/${ACCT}/insights`))!;
  assert.equal(ins.search.get("level"), "ad");
  assert.equal(ins.search.get("date_preset"), "last_7d");
  const snap: any = await store.get("spend", "latest");
  assert.equal(snap.rows.length, 4, "the ad id that is not digits is dropped before it reaches a path");
  assert.deepEqual(snap.rows.find((x: any) => x.ad_id === "1001").cost_per_lead, 75);
  assert.equal(snap.rows.find((x: any) => x.ad_id === "1002").cost_per_lead, null);
  assert.deepEqual(snap.active, ["1001", "1002", "1003"]);
  assert.deepEqual(r, { ads: 4, running: 3, truncated: false });
});

test("review queues one pause for a running ad over the limit, never a paused one, and never twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await pull(ctx);
  const first = await review(ctx);
  assert.equal(first.queued, 1);
  assert.equal(posts().length, 0, "review does not call the platform");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].acts[0].op, "Ad.post.self");
  assert.equal(pending[0].acts[0].input?.params?.["Ad-id"], "1001");
  assert.equal(pending[0].acts[0].input?.params?.status, "PAUSED");
  // 1002 has under the minimum spend, 1003 is under the limit, 1004 is not running.
  await review(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "a re-run never queues the same pause twice");
  const rep: any = await store.get("reports", "latest");
  assert.equal(rep.total_spend, 740);
  assert.equal(rep.total_leads, 7);
  assert.equal(rep.partial, false);
  assert.match(rep.not_covered, /sales records/);
});

test("approving a pause runs it once; the approval then cannot run again", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await pull(ctx); await review(ctx);
  const [id] = Object.keys(await store.list<Approval>("approvals"));
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  const put = posts().find((h) => h.path.endsWith("/1001"))!;
  assert.equal(put.body.status, "PAUSED");
  assert.equal(posts().length, 1);
  await assert.rejects(approve(WF, store, id, "owner"), /already done/);
  assert.equal(posts().length, 1, "nothing ran twice");
});

test("a rejected pause stays rejected: a later review does not queue it again", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await pull(ctx); await review(ctx);
  const [id] = Object.keys(await store.list<Approval>("approvals"));
  await reject(WF, store, id, "owner", NOW);
  await review(ctx);
  const all = Object.values(await store.list<Approval>("approvals"));
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "rejected");
  assert.equal(posts().length, 0);
});

test("no limit set means the report is written and no pause is queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...SET, max_cost_per_lead: undefined }, store, NOW, () => {});
  await pull(ctx);
  assert.equal((await review(ctx)).queued, 0);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.ok(await store.get("reports", "latest"));
});

test("a bad account id stops the run before any network call", async () => {
  const ctx = context(WF, { ...SET, meta: { ad_account_id: "act_1/../../x" } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(pull(ctx), /ad_account_id is not set/);
  assert.equal(hits.length, 0);
});

test("a partial running-ads list is marked in the report", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await pull(ctx);
  const snap: any = await store.get("spend", "latest");
  await store.put("spend", "latest", { ...snap, truncated: true });
  await review(ctx);
  const rep: any = await store.get("reports", "latest");
  assert.equal(rep.partial, true);
});

test("a rejected pause is not asked again while the ad stays over the limit", async () => {
  const store = new MemoryStore();
  const day1 = new Date("2026-11-08T21:00:00Z"), day2 = new Date("2026-11-09T21:00:00Z");
  await pull(context(WF, SET, store, day1)); await review(context(WF, SET, store, day1));
  const [id] = Object.keys(await store.list<Approval>("approvals"));
  await reject(WF, store, id, "owner", day1);
  await pull(context(WF, SET, store, day2)); await review(context(WF, SET, store, day2));
  const all = Object.values(await store.list<Approval>("approvals"));
  assert.equal(all.length, 1, "the same over-limit period does not queue a new pause");
  assert.equal(all[0].status, "rejected");
});

test("an ad paused by approval and reactivated over the limit gets its own approval", async () => {
  const store = new MemoryStore();
  const day1 = new Date("2026-11-08T21:00:00Z"), day2 = new Date("2026-11-09T21:00:00Z"), day3 = new Date("2026-11-10T21:00:00Z");
  await pull(context(WF, SET, store, day1)); await review(context(WF, SET, store, day1));
  const [first] = Object.keys(await store.list<Approval>("approvals"));
  await approve(WF, store, first, "owner", day1);
  activeIds = ["1002", "1003"];          // 1001 is paused now
  await pull(context(WF, SET, store, day2)); await review(context(WF, SET, store, day2));
  activeIds = ["1001", "1002", "1003"];  // the owner reactivates it and it is over the limit again
  await pull(context(WF, SET, store, day3));
  assert.equal((await review(context(WF, SET, store, day3))).queued, 1);
  const pauses = Object.values(await store.list<Approval>("approvals")).filter((a) => a.acts[0].input?.params?.["Ad-id"] === "1001");
  assert.equal(pauses.length, 2, "the new over-limit period has its own approval");
  assert.equal(pauses.filter((a) => a.status === "pending").length, 1);
});
