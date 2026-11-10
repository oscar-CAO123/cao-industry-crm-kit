// Content-learning workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pull, score } from "../industries/all/workflows/marketing/content-learning/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/marketing/content-learning";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const ACCT = "act_123456789";
const IG = "17841400000000001";
const NOW = new Date("2026-11-08T21:30:00Z");

type Hit = { method: string; path: string; search: URLSearchParams; body: any };
let hits: Hit[] = [];
let insightRows: any[] = [];
let activeIds: string[] = [];
let mediaIds: string[] = [];
let mediaInsights: Record<string, Record<string, number>> = {};
let failMediaId: string | null = null;

function fake() {
  hits = [];
  activeIds = ["1001", "1002", "1003"];
  insightRows = [
    { ad_id: "1001", ad_name: "Hook A", campaign_id: "9001", campaign_name: "Prospecting", spend: "150.00", impressions: "5000", clicks: "120", ctr: "2.4", actions: [{ action_type: "lead", value: "2" }] },
    { ad_id: "1002", ad_name: "Hook B", campaign_id: "9001", campaign_name: "Prospecting", spend: "90.00", impressions: "900", clicks: "10", ctr: "1.1", actions: [] },
    { ad_id: "1003", ad_name: "Hook C", campaign_id: "9002", campaign_name: "Retargeting", spend: "200.00", impressions: "8000", clicks: "300", ctr: "3.7", actions: [{ action_type: "lead", value: "5" }] },
    { ad_id: "1004", ad_name: "Old ad", campaign_id: "9002", campaign_name: "Retargeting", spend: "300.00", impressions: "9000", clicks: "200", ctr: "2.2", actions: [] },
    { ad_id: "../x", ad_name: "Bad id", campaign_id: "9002", campaign_name: "Retargeting", spend: "10", impressions: "1", clicks: "1", ctr: "1", actions: [] },
  ];
  mediaIds = ["17001", "17002", "../bad", "17003"];
  mediaInsights = {
    "17001": { reach: 1000, likes: 80, comments: 10, saved: 5, shares: 5 },   // 10 percent
    "17002": { reach: 100, likes: 9, comments: 0, saved: 0, shares: 0 },      // under the reach minimum
    "17003": { reach: 2000, likes: 20, comments: 2, saved: 1, shares: 1 },    // 1.2 percent
  };
  failMediaId = null;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith(`/${ACCT}/insights`) && m === "GET") return json({ data: insightRows });
      if (p.endsWith(`/${ACCT}/ads`) && m === "GET") return json({ data: activeIds.map((id) => ({ id })) });
      if (p.endsWith(`/${IG}/media`) && m === "GET") return json({ data: mediaIds.map((id) => ({ id })) });
      const ins = p.match(/\/([^/]+)\/insights$/);
      if (ins && m === "GET") {
        const id = decodeURIComponent(ins[1]);
        if (failMediaId === id) return new Response("bad metric", { status: 400 });
        const vals = mediaInsights[id] ?? {};
        return json({ data: Object.entries(vals).map(([name, v]) => ({ name, period: "lifetime", values: [{ value: v }] })) });
      }
      if (/\/\d+$/.test(p) && m === "POST") return json({ success: true });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const posts = () => hits.filter((h) => h.method === "POST");
const SET: any = { business_name: "Test Co", currency: "AUD", meta: { ad_account_id: ACCT, instagram_user_id: IG },
  window: "last_30d", min_spend_before_judging: 100, min_reach_before_judging: 200, max_cost_per_lead: 60, pauses_per_run: 5, history_limit: 25 };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { META_ADS_TOKEN: "test-token-not-real", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a pause directly and cannot queue a read", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "Ad.post.self", input: { params: { "Ad-id": "1001", status: "PAUSED" } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "meta-ads", op: "IGUser.get.media", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("pull reads ad results, running ads and Instagram posts, keeps one snapshot, and posts nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  const r = await pull(ctx);
  assert.equal(posts().length, 0, "no write by a cron");
  const ins = hits.find((h) => h.path.endsWith(`/${ACCT}/insights`))!;
  assert.equal(ins.search.get("level"), "ad");
  assert.equal(ins.search.get("date_preset"), "last_30d");
  const snap: any = await store.get("performance", "latest");
  assert.equal(snap.ads.length, 4, "the ad id that is not digits is dropped before it reaches a path");
  assert.equal(snap.ads.find((x: any) => x.id === "1001").cost_per_lead, 75);
  assert.equal(snap.ads.find((x: any) => x.id === "1001").running, true);
  assert.equal(snap.ads.find((x: any) => x.id === "1004").running, false);
  assert.equal(snap.posts.length, 3, "the media id that is not digits is dropped");
  assert.equal(snap.posts.find((x: any) => x.id === "17001").engagement_rate, 0.1);
  assert.equal(snap.posts.find((x: any) => x.id === "17003").engagement_rate, 0.012);
  assert.equal(snap.partial, false);
  assert.deepEqual(r, { ads: 4, posts: 3, partial: false });
});

test("score bands ads and posts against the median and writes the plan that feeds the next brief", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...SET, max_cost_per_lead: undefined }, store, NOW, () => {});
  await pull(ctx);
  const r = await score(ctx);
  assert.equal(posts().length, 0, "score does not call the platform");
  const card: any = await store.get("scores", "latest");
  const band = (id: string) => card.items.find((i: any) => i.id === id).band;
  // Median cost per lead of judged ads with leads is (75 + 40) / 2 = 57.5.
  assert.equal(band("1003"), "working");
  assert.equal(band("1001"), "not working");
  assert.equal(band("1002"), "too early");
  assert.equal(band("1004"), "not working", "an ad with spend and no leads is not working");
  // Median engagement of posts over the reach minimum is (0.1 + 0.012) / 2 = 0.056.
  assert.equal(band("17001"), "working");
  assert.equal(band("17003"), "not working");
  assert.equal(band("17002"), "too early");
  assert.deepEqual(card.plan.make_more.map((x: any) => x.id), ["1003", "17001"]);
  assert.deepEqual(card.plan.fix_or_stop.map((x: any) => x.id), ["1001", "1004", "17003"]);
  assert.equal(card.plan.too_early, 2);
  assert.deepEqual(card.pauses_awaiting_approval, [], "no limit set, so nothing is queued");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.deepEqual(r, { scored: 7, queued: 0 });
  assert.match(card.not_covered, /sales/);
});

test("with a limit, one pause is queued for a running ad over it, never a paused one, and never twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await pull(ctx);
  const first = await score(ctx);
  assert.equal(first.queued, 1);
  assert.equal(posts().length, 0, "score does not call the platform");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].acts[0].op, "Ad.post.self");
  assert.equal(pending[0].acts[0].input?.params?.["Ad-id"], "1001");
  assert.equal(pending[0].acts[0].input?.params?.status, "PAUSED");
  // 1002 is under the spend minimum, 1003 is under the limit, 1004 is not running.
  await score(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "a re-run never queues the same pause twice");
});

test("approving the pause runs it once; the approval then cannot run again", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await pull(ctx); await score(ctx);
  const [id] = Object.keys(await store.list<Approval>("approvals"));
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  const put = posts().find((h) => h.path.endsWith("/1001"))!;
  assert.equal(put.body.status, "PAUSED");
  assert.equal(posts().length, 1);
  await assert.rejects(approve(WF, store, id, "owner"), /already done/);
  assert.equal(posts().length, 1, "nothing ran twice");
});

test("a rejected pause stays rejected: a later score does not queue it again", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await pull(ctx); await score(ctx);
  const [id] = Object.keys(await store.list<Approval>("approvals"));
  await reject(WF, store, id, "owner", NOW);
  await score(ctx);
  const all = Object.values(await store.list<Approval>("approvals"));
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "rejected");
  assert.equal(posts().length, 0);
});

test("a post whose insights fail is left out and the run is marked partial", async () => {
  failMediaId = "17003";
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  const r = await pull(ctx);
  const snap: any = await store.get("performance", "latest");
  assert.equal(snap.posts.length, 2);
  assert.equal(snap.partial, true);
  assert.equal(r.partial, true);
});

test("a bad account id stops the run before any network call", async () => {
  const ctx = context(WF, { ...SET, meta: { ad_account_id: "act_1/../../x", instagram_user_id: IG } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(pull(ctx), /ad_account_id must be act_ followed by digits/);
  assert.equal(hits.length, 0);
});

test("no account at all stops the run before any network call", async () => {
  const ctx = context(WF, { ...SET, meta: {} }, new MemoryStore(), NOW, () => {});
  await assert.rejects(pull(ctx), /set settings\.meta\.ad_account_id/);
  assert.equal(hits.length, 0);
});

test("score before any pull writes nothing and queues nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  const r = await score(ctx);
  assert.deepEqual(r, { scored: 0, queued: 0, reason: "no snapshot yet" });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.equal(hits.length, 0);
});

test("a rejected pause is not asked again while the ad stays over the limit", async () => {
  const store = new MemoryStore();
  const day1 = new Date("2026-11-08T21:30:00Z"), day2 = new Date("2026-11-09T21:30:00Z");
  await pull(context(WF, SET, store, day1)); await score(context(WF, SET, store, day1));
  const [id] = Object.keys(await store.list<Approval>("approvals"));
  await reject(WF, store, id, "owner", day1);
  await pull(context(WF, SET, store, day2)); await score(context(WF, SET, store, day2));
  const all = Object.values(await store.list<Approval>("approvals"));
  assert.equal(all.length, 1, "the same over-limit period does not queue a new pause");
  assert.equal(all[0].status, "rejected");
});

test("an ad paused by approval and reactivated over the limit gets its own approval", async () => {
  const store = new MemoryStore();
  const day1 = new Date("2026-11-08T21:30:00Z"), day2 = new Date("2026-11-09T21:30:00Z"), day3 = new Date("2026-11-10T21:30:00Z");
  await pull(context(WF, SET, store, day1)); await score(context(WF, SET, store, day1));
  const [first] = Object.keys(await store.list<Approval>("approvals"));
  await approve(WF, store, first, "owner", day1);
  activeIds = ["1002", "1003"];          // 1001 is paused now
  await pull(context(WF, SET, store, day2)); await score(context(WF, SET, store, day2));
  activeIds = ["1001", "1002", "1003"];  // reactivated and over the limit again
  await pull(context(WF, SET, store, day3));
  assert.equal((await score(context(WF, SET, store, day3))).queued, 1);
  const pauses = Object.values(await store.list<Approval>("approvals")).filter((a) => a.acts[0].input?.params?.["Ad-id"] === "1001");
  assert.equal(pauses.length, 2, "the new over-limit period has its own approval");
  assert.equal(pauses.filter((a) => a.status === "pending").length, 1);
});
