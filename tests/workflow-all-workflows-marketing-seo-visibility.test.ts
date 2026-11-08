// seo-visibility workflow tests. Every request goes to a fake network: no test reaches a real Ahrefs account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS, rankings, keywords, backlinks, aiVisibility } from "../industries/all/workflows/marketing/seo-visibility/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/marketing/seo-visibility/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const S: any = {
  business_name: "Test Plumbing",
  ahrefs: { target: "example.com.au", project_id: 4242, country: "au", device: "desktop" },
  seed_keywords: ["emergency plumber sydney"],
  retire_keywords: ["cheap plumber"],
  brand_radar: { report_id: "rep-1", brand: "Test Plumbing", models: "chatgpt,perplexity" },
};

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let tracked = ["emergency plumber sydney", "cheap plumber", "blocked drain sydney"];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/rank-tracker/overview")) return json({ overviews: [{ keyword: "emergency plumber sydney", best_position_kind: "organic", clicks: 12, country: "au" }] });
      if (p.endsWith("/gsc/keywords")) return json({ keywords: [{ keyword: "plumber sydney", clicks: 40 }] });
      if (p.endsWith("/keywords-explorer/overview")) return json({ keywords: [{ keyword: "emergency plumber sydney", volume: 320, difficulty: 22 }] });
      if (p.endsWith("/management/project-keywords") && m === "GET") return json({ keywords: tracked.map((k) => ({ keyword: k })) });
      if (p.endsWith("/site-explorer/broken-backlinks")) return json({ backlinks: [{ anchor: "plumbers", first_seen_link: "https://news.example/x", http_code_target: 404, domain_rating_source: 45 }] });
      if (p.endsWith("/brand-radar/sov-overview")) return json({ metrics: [{ brand: "Test Plumbing", entity_type: "brand", share_of_voice: 0.1 }] });
      if (p.endsWith("/management/project-keywords-delete") && m === "PUT") return json({});
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  tracked = ["emergency plumber sydney", "cheap plumber", "blocked drain sydney"];
  Object.assign(process.env, { AHREFS_API_KEY: "k", KIT_ALLOW_WRITES: "1" });
});

test("the crons match the workflow's entries", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("crons read and save reports; no cron run sends a write to Ahrefs", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await rankings(ctx), { saved: "2026-11-08" });
  await keywords(ctx); await backlinks(ctx); await aiVisibility(ctx);
  assert.ok(hits.length >= 5, "each cron reads from Ahrefs");
  assert.deepEqual(hits.filter((h) => h.method !== "GET"), [], "no write reaches Ahrefs from a cron");
  assert.deepEqual(Object.keys(await store.list("reports")).sort(), ["ai-visibility:2026-11-08", "backlinks:2026-11-08", "keywords:2026-11-08", "rankings:2026-11-08"]);
});

test("the keywords cron only queues the retired keyword; approval removes it once, and re-runs never queue twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await keywords(ctx).then((r: any) => r.retire), 1);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.equal(hits.filter((h) => h.method === "PUT").length, 0, "queued, not run");
  await keywords(ctx);
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "re-runs never queue twice");

  process.env.KIT_ALLOW_WRITES = "0";
  const blocked = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(blocked.status, "failed", "approval without writes allowed does not run");
  assert.equal(hits.filter((h) => h.method === "PUT").length, 0);

  process.env.KIT_ALLOW_WRITES = "1";
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const del = hits.filter((h) => h.method === "PUT");
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].body, { keywords: [{ keyword: "cheap plumber" }] });
  assert.equal(del[0].query.get("project_id"), "4242");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("a retired keyword that is not tracked is never queued", async () => {
  tracked = ["emergency plumber sydney"];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await keywords(ctx), { queued: null, retire: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("the runtime keeps reads and removals apart: a draft cannot run the removal, a cron cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "ahrefs", op: "management.project-keywords-delete", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "ahrefs", op: "rank-tracker.overview", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("bad settings stop a cron before any request, and a domain cannot carry extra query text", async () => {
  const badProject = context(WF, { ...S, ahrefs: { ...S.ahrefs, project_id: 0 } }, new MemoryStore(), NOW, () => {});
  assert.match(JSON.stringify(await rankings(badProject)), /project_id/);
  const badDomain = context(WF, { ...S, ahrefs: { ...S.ahrefs, target: "example.com.au&x=1" } }, new MemoryStore(), NOW, () => {});
  assert.match(JSON.stringify(await backlinks(badDomain)), /target/);
  const noReport = context(WF, { ...S, brand_radar: { models: "chatgpt" } }, new MemoryStore(), NOW, () => {});
  assert.match(JSON.stringify(await aiVisibility(noReport)), /report_id/);
  assert.equal(hits.length, 0);
});
