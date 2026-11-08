// Ad-campaigns workflow tests. Every request goes to a fake network: no test reaches a real ad account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { plan, build, review, CRONS } from "../industries/all/workflows/marketing/ad-campaigns/index.ts";
import { main } from "../tools/workflow.ts";

const DIR = "industries/all/workflows/marketing/ad-campaigns";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const S: any = { business_name: "Example Trades", meta: { ad_account_id: "act_123", page_id: "456" }, countries: ["AU"], max_daily_budget_minor: 50000 };
const PLAN: any = { id: "spring-leads", name: "Spring leads", objective: "OUTCOME_TRAFFIC", daily_budget_minor: 5000, image_url: "https://example.com/pic.jpg",
  link: "https://example.com/quote", headline: "Get a quote", message: "Book a free quote this week.", status: "planned" };
const LEAD: any = { ...PLAN, id: "lead-form", objective: "OUTCOME_LEADS", lead_gen_form_id: "789" };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let failAdset = false;

function fake() {
  hits = []; failAdset = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v21.0/act_123/campaigns" && m === "POST") return json({ id: "1001" });
      if (p === "/v21.0/act_123/adsets" && m === "POST") return failAdset ? json({ error: { message: "rejected" } }, 500) : json({ id: "2001" });
      if (p === "/v21.0/act_123/adcreatives" && m === "POST") return json({ id: "3001" });
      if (p === "/v21.0/act_123/ads" && m === "POST") return json({ id: "4001" });
      if (p === "/v21.0/act_123/insights" && m === "GET") return json({ data: [{ campaign_id: "1001", campaign_name: "Spring leads", spend: "12.40",
        impressions: "900", clicks: "20", ctr: "2.2", cpc: "0.62", actions: [{ action_type: "link_click", value: "18" }] }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

/** Approve whatever is pending, then build again, until the plan stops moving. */
async function complete(store: MemoryStore) {
  const ctx = context(WF, S, store, NOW, () => {});
  for (let i = 0; i < 8; i++) {
    await build(ctx);
    const pending = (await main(["approvals", DIR], store) as any[]).filter((x) => x.status === "pending");
    if (!pending.length) break;
    await approve(WF, store, pending[0].id, "owner", NOW);
  }
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { META_ADS_TOKEN: "t", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a create and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "AdAccount.post.campaigns", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "meta-ads", op: "AdAccount.get.insights", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("the crons are the three declared in workflow.json", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["build", "plan", "review"]);
  for (const c of WF.crons) assert.ok(CRONS[c.entry], `cron ${c.entry} has no function`);
});

test("bad plans and bad settings are refused before any call", async () => {
  const store = new MemoryStore();
  const bad = [
    { ...PLAN, id: "bad-image", image_url: "http://example.com/pic.jpg" },
    { ...PLAN, id: "over-cap", daily_budget_minor: 60000 },
    { ...PLAN, id: "no-form", objective: "OUTCOME_LEADS" },
    { ...PLAN, id: "bad-age", age_min: 13 },
    { ...PLAN, id: "login-link", link: "https://user:pw@example.com/" },
  ];
  for (const p of bad) await store.put("campaigns", p.id, p);
  assert.deepEqual(await plan(context(WF, S, store, NOW, () => {})), { ready: 0, skipped: 5 });
  for (const p of bad) assert.equal((await store.get<any>("campaigns", p.id)).status, "skipped");
  assert.equal(hits.length, 0);
  await assert.rejects(plan(context(WF, { ...S, meta: {} }, store, NOW, () => {})), /ad_account_id/);
});

test("a valid plan is queued for approval, and a re-run never queues it twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("campaigns", PLAN.id, PLAN);
  assert.deepEqual(await plan(ctx), { ready: 1, skipped: 0 });
  assert.deepEqual(await build(ctx), { built: 0, waiting: 1, blocked: 0, rejected: 0 });
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "queuing never calls Meta");
  const pending = await main(["approvals", DIR], store) as any[];
  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /campaign/);
  await plan(ctx); await build(ctx);
  assert.equal((await main(["approvals", DIR], store) as any[]).length, 1, "re-runs never queue twice");
});

test("approving each step builds the campaign with every object PAUSED and linked by id", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("campaigns", PLAN.id, PLAN);
  await plan(ctx);
  await complete(store);
  const p = await store.get<any>("campaigns", PLAN.id);
  assert.equal(p.status, "built");
  assert.deepEqual(p.ids, { campaign: "1001", adset: "2001", creative: "3001", ad: "4001" });
  const posts = hits.filter((h) => h.method === "POST");
  assert.deepEqual(posts.map((h) => h.path.split("/").pop()), ["campaigns", "adsets", "adcreatives", "ads"]);
  assert.deepEqual(posts.map((h) => h.body.status), ["PAUSED", "PAUSED", undefined, "PAUSED"]);
  assert.equal(posts[1].body.campaign_id, "1001");
  assert.equal(posts[1].body.daily_budget, 5000);
  assert.equal(posts[1].body.optimization_goal, "LINK_CLICKS");
  assert.deepEqual(posts[1].body.targeting.geo_locations, { countries: ["AU"] });
  assert.equal(posts[2].body.object_story_spec.page_id, "456");
  assert.equal(posts[2].body.object_story_spec.link_data.call_to_action.type, "LEARN_MORE");
  assert.deepEqual(posts[3].body.creative, { creative_id: "3001" });
  assert.equal(posts[3].body.adset_id, "2001");
});

test("a lead plan targets the Page and the lead form", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("campaigns", LEAD.id, LEAD);
  await plan(ctx);
  await complete(store);
  const posts = hits.filter((h) => h.method === "POST");
  assert.equal(posts[1].body.optimization_goal, "LEAD_GENERATION");
  assert.deepEqual(posts[1].body.promoted_object, { page_id: "456" });
  assert.deepEqual(posts[2].body.object_story_spec.link_data.call_to_action, { type: "SIGN_UP", value: { lead_gen_form_id: "789" } });
});

test("a failed create blocks the plan, and nothing after it is queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("campaigns", PLAN.id, PLAN);
  await plan(ctx); await build(ctx);
  await approve(WF, store, (await main(["approvals", DIR], store) as any[])[0].id, "owner", NOW);
  await build(ctx);
  failAdset = true;
  const [adset] = await main(["approvals", DIR], store) as any[];
  const res = await approve(WF, store, adset.id, "owner", NOW);
  assert.equal(res.status, "failed");
  await build(ctx);
  const p = await store.get<any>("campaigns", PLAN.id);
  assert.equal(p.status, "blocked");
  assert.match(p.reason, /^adset: failed/);
  assert.equal(p.approvals.creative, undefined);
  assert.equal(hits.filter((h) => h.path.endsWith("/adcreatives")).length, 0);
});

test("the SDK gate refuses a create when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("campaigns", PLAN.id, PLAN);
  await plan(ctx); await build(ctx);
  const [ap] = await main(["approvals", DIR], store) as any[];
  const res = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(res.status, "failed");
  assert.equal(hits.filter((h) => h.method === "POST").length, 0);
});

test("review reads the last seven days per campaign and only reads", async () => {
  const store = new MemoryStore();
  await review(context(WF, S, store, NOW, () => {}));
  assert.ok(hits.length > 0 && hits.every((h) => h.method === "GET"));
  assert.equal(hits[0].path, "/v21.0/act_123/insights");
  const latest: any = await store.get("reviews", "latest");
  assert.equal(latest.days, 7);
  assert.deepEqual(latest.rows, [{ campaign_id: "1001", campaign_name: "Spring leads", spend: "12.40", impressions: "900", clicks: "20", results: 18 }]);
});
