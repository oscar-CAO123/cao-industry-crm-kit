// Competitor-watch workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe } from "../core/sdk/call.ts";
import { discover, watch, authority, report, CRONS } from "../industries/all/workflows/marketing/competitor-watch/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/marketing/competitor-watch";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const PAGE = "111222333444555";
const KEY_S = "sr-test-key-value", KEY_M = "meta-test-token-value";

type Hit = { method: string; path: string; query: Record<string, string>; body: any };
let hits: Hit[] = [];
let pagePosts: { id: string; created_time: string; message: string; permalink_url?: string }[] = [];
let authScore: Record<string, number> = {};
let projectId = "PRJ-1";
let createFail = 0;

function fake() {
  hits = []; pagePosts = []; authScore = { "example.com.au": 40, "rival-one.com.au": 58, "rival-two.com.au": 31, "other.com": 90 };
  projectId = "PRJ-1"; createFail = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: Object.fromEntries(u.searchParams), body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/apis/v4/backlinks/v1/competitors") return json({ meta: { success: true }, data: [
        { domain: "rival-one.com.au", similarity: 0.75, common_refdomains: 12 },
        { domain: "example.com.au", similarity: 1, common_refdomains: 99 },
        { domain: "not a domain", similarity: 0.4, common_refdomains: 1 },
        { domain: "rival-three.com.au", similarity: 0.5, common_refdomains: 4 } ] });
      if (p === "/apis/v4/backlinks/v1/comparison") return json({ meta: { success: true }, data: Object.entries(authScore).map(([url, score]) =>
        ({ url, score, backlinks_count: score * 10, domains_count: score, follows_count: score * 8, month_date: "2026-11-01" })) });
      if (p === "/apis/v4/projects/v1/projects" && m === "POST") {
        if (createFail-- > 0) return json({ error: "boom" }, 500);
        return json({ meta: { status_code: 201, success: true }, data: { id: projectId, domain: body?.domain, project_name: body?.project_name } }, 201);
      }
      const pm = /\/(\d+)\/posts$/.exec(p);
      if (pm) return json({ data: pm[1] === PAGE ? pagePosts : [], paging: {} });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const S: any = {
  business_name: "Example Business", domain: "example.com.au",
  competitors: [
    { name: "Rival One", domain: "rival-one.com.au", facebook_page_id: PAGE },
    { name: "Rival Two", domain: "rival-two.com.au" },
  ],
  semrush_project_name: "Competitor watch example.com.au",
};
const NOW = new Date("2026-11-08T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SEMRUSH_API_KEY: KEY_S, META_ADS_TOKEN: KEY_M, KIT_ALLOW_WRITES: "1" });
});

test("every operation the workflow lists is mapped in the kit", () => {
  for (const [p, ops] of Object.entries({ ...WF.draft_ops, ...WF.live_ops })) for (const op of ops) assert.ok(describe(p, op), `${p} ${op}`);
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), Object.keys(CRONS).sort());
  assert.equal(WF.id, "competitor-watch");
});

test("runtime: a draft cannot run the live project create, and a cron cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "semrush", op: "docs.post_apis_v4_projects_v1_projects", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "semrush", op: "docs.get_apis_v4_backlinks_v1_competitors", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("bad settings stop every cron before any call", async () => {
  const bad: any[] = [
    { ...S, domain: "https://example.com" },
    { ...S, competitors: [{ name: "X", facebook_page_id: "abc" }] },
    { ...S, competitors: [{ name: "X" }] },
    { ...S, competitors: Array.from({ length: 10 }, (_, i) => ({ name: `C${i}`, domain: `c${i}.com.au` })) },
    { ...S, semrush_project_name: "Watch: example" },
  ];
  for (const s of bad) for (const fn of [discover, watch, authority, report]) {
    await assert.rejects(fn(context(WF, s, new MemoryStore(), NOW, () => {})), /competitor-watch: /);
  }
  assert.equal(hits.length, 0);
});

test("discover: suggestions are drafted, the project is queued once and runs only on approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await discover(ctx), { suggestions: 2, queued: 1 });
  assert.equal(writes().length, 0, "nothing created by the cron");
  const sug = await store.get<any>("suggestions", "latest");
  assert.deepEqual(sug.items.map((x: any) => x.domain), ["rival-one.com.au", "rival-three.com.au"], "own domain and junk dropped");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["docs.post_apis_v4_projects_v1_projects"]);
  assert.deepEqual(await discover(context(WF, S, store, NOW, () => {})), { suggestions: 2, queued: 1 });
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "re-runs never queue twice");
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(writes().length, 1);
  assert.deepEqual(writes()[0].body, { domain: "example.com.au", project_name: "Competitor watch example.com.au" });
  assert.equal(done.results?.[0]?.ref?.id, "PRJ-1", "the project id is kept on the approval");
  assert.deepEqual(await discover(context(WF, S, store, NOW, () => {})), { suggestions: 2, queued: 0 }, "no second project once one is approved");
});

test("a failed project create can be approved again without a second approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await discover(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  createFail = 1;
  // A 500 may have been processed by the app: the approval waits for a person to check, and nothing resends on its own.
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "needs-check");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /needs a check/, "approving again without a confirmation sends nothing");
  assert.equal((await approve(WF, store, ap.id, "owner", NOW, "retry")).status, "done");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
  assert.equal(writes().length, 2);
});

test("watch: the first run only sets the baseline; the next run reports only new posts; unsafe links are dropped", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  pagePosts = [
    { id: `${PAGE}_1`, created_time: "2026-11-07T10:00:00+0000", message: "Spring sale", permalink_url: "https://www.facebook.com/rival/posts/1" },
    { id: `${PAGE}_2`, created_time: "2026-11-06T10:00:00+0000", message: "Old post", permalink_url: "javascript:alert(1)" },
  ];
  assert.deepEqual(await watch(ctx), { pages: 1, new_posts: 0, baselined: 1 });
  const base = await store.get<any>("posts", PAGE);
  assert.equal(base.baseline, true);
  assert.deepEqual(base.new_posts, []);
  pagePosts.unshift({ id: `${PAGE}_3`, created_time: "2026-11-08T05:00:00+0000", message: "Free quote\u0007 today" });
  assert.deepEqual(await watch(ctx), { pages: 1, new_posts: 1, baselined: 0 });
  const next = await store.get<any>("posts", PAGE);
  assert.equal(next.new_posts[0].id, `${PAGE}_3`);
  assert.ok(!next.new_posts[0].message.includes("\u0007"), "control characters removed");
  const second = (await store.get<any>("seen", PAGE)).ids;
  assert.ok(second.includes(`${PAGE}_1`) && second.includes(`${PAGE}_3`));
  assert.equal(writes().length, 0, "watch only reads");
});

test("authority: keeps last week's numbers and sends only the domains asked for", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await authority(ctx), { domains: 3, rows: 3 });
  const q = hits.find((h) => h.path.endsWith("/comparison"))!.query;
  assert.equal(q.urls, "example.com.au,rival-one.com.au,rival-two.com.au");
  assert.equal(q.scope, "ROOT_DOMAIN");
  authScore["example.com.au"] = 43;
  await authority(context(WF, S, store, NOW, () => {}));
  const prev = await store.get<any>("authority", "previous");
  const latest = await store.get<any>("authority", "latest");
  assert.equal(prev.rows.find((r: any) => r.domain === "example.com.au").score, 40);
  assert.equal(latest.rows.find((r: any) => r.domain === "example.com.au").score, 43);
  assert.equal(writes().length, 0);
});

test("report: no platform calls; shows new posts, authority change, watch gaps, and what is not covered", async () => {
  const store = new MemoryStore();
  pagePosts = [{ id: `${PAGE}_1`, created_time: "2026-11-07T10:00:00+0000", message: "Spring sale" }];
  await watch(context(WF, S, store, NOW, () => {}));
  await authority(context(WF, S, store, NOW, () => {}));
  await discover(context(WF, S, store, NOW, () => {}));
  pagePosts.unshift({ id: `${PAGE}_9`, created_time: "2026-11-08T05:00:00+0000", message: "New offer" });
  await watch(context(WF, S, store, NOW, () => {}));
  authScore["example.com.au"] = 43;
  await authority(context(WF, S, store, NOW, () => {}));
  const before = hits.length;
  await report(context(WF, S, store, NOW, () => {}));
  assert.equal(hits.length, before, "report makes no calls");
  const r = await store.get<any>("reports", "latest");
  assert.equal(r.new_posts.length, 1);
  assert.equal(r.new_posts[0].competitor, "Rival One");
  assert.equal(r.authority.find((x: any) => x.domain === "example.com.au").score_change, 3);
  assert.ok(r.missing.some((m: string) => /Rival Two: no Facebook Page id/.test(m)));
  assert.deepEqual(r.suggestions.map((x: any) => x.domain), ["rival-three.com.au"], "watched domains are not suggested again");
  assert.match(r.not_covered, /Competitor ads and prices are not covered/);
});

test("crons read and store; nothing is written until a person approves the project", async () => {
  const store = new MemoryStore();
  pagePosts = [{ id: `${PAGE}_1`, created_time: "2026-11-07T10:00:00+0000", message: "Spring sale" }];
  for (const name of ["discover", "watch", "authority", "report"]) await CRONS[name](context(WF, S, store, NOW, () => {}));
  assert.equal(writes().length, 0, "no POST from any cron but the queued approval");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
});

test("no key value is written to the workflow store", async () => {
  const store = new MemoryStore();
  pagePosts = [{ id: `${PAGE}_1`, created_time: "2026-11-07T10:00:00+0000", message: "Spring sale" }];
  for (const name of ["discover", "watch", "authority", "report"]) await CRONS[name](context(WF, S, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  for (const ns of ["suggestions", "seen", "posts", "authority", "reports", "approvals"]) {
    const text = JSON.stringify(await store.list(ns));
    assert.ok(!text.includes(KEY_S) && !text.includes(KEY_M), `${ns} holds no key`);
  }
});
