// Marketing-data workflow tests. Every request goes to a fake network: no test reaches a real ad account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pull, review, CRONS } from "../industries/professional-services/workflows/marketing/marketing/index.ts";

const FOLDER = "industries/professional-services/workflows/marketing/marketing";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const ACCT = "act_12345678901";
const S: any = { business_name: "Test Firm", currency: "AUD", meta: { ad_account_id: ACCT }, window: "last_7d" };
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; query: Record<string, string> };
let hits: Hit[] = [];
let rows: any[] = [];
let paging: any = undefined;

function fake(data: any[] = rows, extra: any = {}) {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET";
      hits.push({ method: m, path: u.pathname, query: Object.fromEntries(u.searchParams) });
      if (u.pathname.endsWith(`/${ACCT}/insights`) && m === "GET")
        return new Response(JSON.stringify({ data, ...extra }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("not faked: " + u.pathname, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

const ROWS = [
  { campaign_id: "120000000000001", campaign_name: "Brand search", spend: "120.50", impressions: "4000", clicks: "210",
    actions: [{ action_type: "lead", value: "6" }, { action_type: "link_click", value: "200" }], date_start: "2026-11-02", date_stop: "2026-11-08" },
  { campaign_id: "120000000000002", campaign_name: "Retargeting", spend: "40", impressions: "900", clicks: "30",
    actions: [], date_start: "2026-11-02", date_stop: "2026-11-08" },
  { campaign_id: "not-digits", campaign_name: "Bad id", spend: "9", impressions: "1", clicks: "1",
    actions: [{ action_type: "lead", value: "1" }], date_start: "2026-11-02", date_stop: "2026-11-08" },
];

beforeEach(() => {
  rows = ROWS; paging = undefined;
  fake(); setTokenStore(new MemoryTokenStore());
  process.env.META_ADS_TOKEN = "meta-test-token";
});

test("pull reads campaign insights only, sends nothing, and keeps a clean snapshot", async () => {
  fake(rows, paging ? { paging } : {});
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await pull(ctx), { campaigns: 2, truncated: false });
  assert.equal(writes().length, 0, "no write reaches the ad account");
  const [h] = hits;
  assert.equal(h.query.level, "campaign");
  assert.equal(h.query.date_preset, "last_7d");
  const snap = (await store.get<any>("marketing", "latest"))!;
  assert.equal(snap.rows.length, 2, "a campaign id that is not digits is dropped");
  const brand = snap.rows.find((r: any) => r.campaign_id === "120000000000001");
  assert.equal(brand.spend, 120.5);
  assert.equal(brand.leads, 6);
  assert.equal(brand.cost_per_lead, 20.08);
  assert.equal(snap.rows.find((r: any) => r.campaign_id === "120000000000002").cost_per_lead, null);
});

test("review writes the report from the snapshot with totals, and touches nothing outside the store", async () => {
  const store = new MemoryStore();
  await pull(context(WF, S, store, NOW, () => {}));
  fake();
  assert.deepEqual(await review(context(WF, S, store, NOW, () => {})), { written: true, campaigns: 2, leads: 6 });
  assert.equal(hits.length, 0, "review makes no network call");
  const rep = (await store.get<any>("reports", "latest"))!;
  assert.equal(rep.total_spend, 160.5);
  assert.equal(rep.total_leads, 6);
  assert.equal(rep.blended_cost_per_lead, 26.75);
  assert.equal(rep.campaigns[0].campaign_name, "Brand search", "sorted by spend, largest first");
  assert.equal(rep.partial, false);
});

test("re-runs keep one snapshot and one report, with the same totals", async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 2; i++) {
    await pull(context(WF, S, store, NOW, () => {}));
    await review(context(WF, S, store, NOW, () => {}));
  }
  assert.equal(Object.keys(await store.list("marketing")).length, 1);
  assert.equal(Object.keys(await store.list("reports")).length, 1);
  assert.equal((await store.get<any>("reports", "latest")).total_spend, 160.5);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0, "nothing queued");
});

test("review with no snapshot writes nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await review(context(WF, S, store, NOW, () => {})), { written: false, reason: "no snapshot yet" });
  assert.equal(await store.get("reports", "latest"), undefined);
});

test("a partial list is marked partial and carried into the report", async () => {
  fake(rows, { paging: { next: "https://graph.facebook.com/next" } });
  const store = new MemoryStore();
  assert.deepEqual(await pull(context(WF, S, store, NOW, () => {})), { campaigns: 2, truncated: true });
  await review(context(WF, S, store, NOW, () => {}));
  assert.equal((await store.get<any>("reports", "latest")).partial, true);
});

test("bad settings stop before any network call", async () => {
  const store = new MemoryStore();
  await assert.rejects(pull(context(WF, { ...S, meta: { ad_account_id: "12345" } }, store, NOW, () => {})), /act_1234567890/);
  await assert.rejects(pull(context(WF, { ...S, window: "last_365d" }, store, NOW, () => {})), /window must be one of/);
  assert.equal(hits.length, 0);
});

test("a write is refused as a draft, and nothing can be queued because no live operation is mapped", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "AdAccount.post.tracking", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "Ad.post.self", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "meta-ads", op: "Ad.post.self", summary: "pause" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("the cron table maps every entry the workflow declares", () => {
  for (const c of WF.crons) assert.equal(typeof (CRONS as any)[c.entry], "function", `${c.entry} is a cron`);
});
