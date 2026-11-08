// Creative test reader tests. Every request goes to a fake network: no test reaches a real ad account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { monitor, review } from "../industries/agencies/workflows/marketing/creative/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/agencies/workflows/marketing/creative/workflow.json", "utf8")) as WorkflowRecord;
const ACCT = "act_123456789", AD_LOSER = "111111111", AD_GOOD = "222222222", AD_OFF = "333333333";
const ROWS = [
  { ad_id: AD_LOSER, ad_name: "Hook A", spend: "150.00", impressions: "20000", clicks: "60", ctr: "0.3", cpc: "2.5" },
  { ad_id: AD_GOOD, ad_name: "Hook B", spend: "160.00", impressions: "9000", clicks: "171", ctr: "1.9", cpc: "0.94" },
  { ad_id: AD_OFF, ad_name: "Hook C (already off)", spend: "300.00", impressions: "40000", clicks: "40", ctr: "0.1", cpc: "7.5" },
];
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
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (m === "GET" && p.endsWith(`/${ACCT}/insights`)) return json({ data: ROWS });
      if (m === "GET" && p.endsWith(`/${ACCT}/ads`)) return json({ data: [{ id: AD_LOSER }, { id: AD_GOOD }] });
      if (m === "POST" && p.endsWith(`/${AD_LOSER}`)) return json({ success: true });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const S: any = { business_name: "Test Agency", meta_ads: { ad_account: ACCT }, min_spend: 100, min_ctr_percent: 0.5 };
const NOW = new Date("2026-11-09T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { META_ADS_TOKEN: "test-token", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "Ad.post.self", summary: "x" }), /not a draft operation/);
});

test("a bad ad account id is refused before any request is made", async () => {
  const ctx = context(WF, { ...S, meta_ads: { ad_account: "1234" } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(monitor(ctx), /ad_account/);
  assert.equal(hits.length, 0);
});

test("monitor reads every ad and keeps a snapshot, with no writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await monitor(ctx), { ads: 3 });
  const snap = await store.get<any>("snapshot", "latest");
  assert.equal(snap.rows.length, 3);
  assert.equal(snap.rows[0].ctr, 0.3);
  assert.equal(writes().length, 0, "a cron sends nothing");
});

test("review queues one pause for the active losing ad only, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await monitor(ctx);
  assert.deepEqual(await review(ctx), { queued: 1 });
  assert.equal(writes().length, 0, "the pause waits for approval");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => [a.platform, a.op, a.input]), [["meta-ads", "Ad.post.self", { params: { "Ad-id": AD_LOSER }, body: { status: "PAUSED" } }]]);
});

test("re-running review never queues the same pause twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await monitor(ctx); await review(ctx); await review(ctx);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("approval runs the pause on the ad, once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await monitor(ctx); await review(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].method, "POST");
  assert.ok(w[0].path.endsWith(`/${AD_LOSER}`));
  assert.deepEqual(w[0].body, { status: "PAUSED" });
});
