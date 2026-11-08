// Content-posting workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { draft, track } from "../industries/all/workflows/marketing/content-posting/index.ts";
import { render, TARGETS } from "../tools/deploy.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/marketing/content-posting";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const IG = "17841400000000001", PAGE = "104000000000002", CONTAINER = "17900000000000777", PUBLISHED = "17900000000000999";
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let postable = true;

function fake() {
  hits = []; postable = true;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith(`/${IG}/media`) && m === "POST") return postable ? json({ id: CONTAINER }) : new Response("{}", { status: 400 });
      if (p.endsWith(`/${IG}/media_publish`) && m === "POST") return json({ id: PUBLISHED });
      if (p.endsWith(`/${PAGE}/photos`) && m === "POST") return json({ id: "p-photo", post_id: "p-post" });
      if (p.endsWith(`/${PAGE}/feed`) && m === "POST") return json({ id: "p-feed" });
      if (p.endsWith(`/${IG}/media`) && m === "GET") return json({ data: [{ id: "17900000000000101" }, { id: "17900000000000102" }] });
      if (p.endsWith(`/${PAGE}/published_posts`) && m === "GET") return json({ data: [{ id: `${PAGE}_9` }] });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const sends = () => hits.filter((h) => h.method === "POST");
const BOTH: any = { business_name: "Test Cafe", channels: ["instagram", "facebook"], meta: { instagram_user_id: IG, facebook_page_id: PAGE }, post_limit_per_run: 5 };
const PICTURE = "https://images.example.com/cafe/morning.jpg";

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { META_ADS_TOKEN: "test-token-not-real", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, BOTH, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "IGUser.post.media_publish", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "Page.post.feed", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "meta-ads", op: "IGUser.post.media", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("a planned Instagram and Facebook post: the cron makes one draft container and queues the publish, and publishes nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, BOTH, store, NOW, () => {});
  await store.put("posts", "morning-1", { id: "morning-1", caption: "Fresh bread at 7am.", image_url: PICTURE, channels: ["instagram", "facebook"], status: "planned" });
  assert.deepEqual(await draft(ctx), { drafted: 1, queued: 1, skipped: 0 });
  const posts = hits.filter((h) => h.method === "POST");
  assert.deepEqual(posts.map((h) => h.path.split("/").pop()), ["media"], "only the container is created");
  assert.equal(posts[0].body.image_url, PICTURE, "the spec puts image_url and caption in the body");
  assert.equal(posts[0].body.caption, "Fresh bread at 7am.");
  assert.ok(!hits.some((h) => h.path.endsWith("/media_publish") || h.path.endsWith("/photos") || h.path.endsWith("/feed")), "nothing published by the cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["IGUser.post.media_publish", "Page.post.photos"]);
  assert.equal(ap.acts[0].input!.params!.creation_id, CONTAINER, "the publish carries the container the draft made");
  assert.match(ap.summary, /Publish morning-1 to instagram and facebook/);
  const saved = await store.get<any>("posts", "morning-1");
  assert.equal(saved.status, "queued");
  assert.equal(saved.instagram.creation_id, CONTAINER);
});

test("re-runs never create a second container or queue a second approval", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, BOTH, store, NOW, () => {});
  await store.put("posts", "morning-1", { id: "morning-1", caption: "Fresh bread at 7am.", image_url: PICTURE, channels: ["instagram"], status: "planned" });
  await draft(ctx()); await draft(ctx()); await draft(ctx());
  assert.equal(hits.filter((h) => h.path.endsWith(`/${IG}/media`) && h.method === "POST").length, 1, "one container");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "one approval");
});

test("a rejected post is not queued again by the cron", async () => {
  const store = new MemoryStore();
  await store.put("posts", "morning-1", { id: "morning-1", caption: "Fresh bread at 7am.", image_url: PICTURE, channels: ["instagram"], status: "planned" });
  await draft(context(WF, BOTH, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await reject(WF, store, ap.id, "owner", NOW);
  await draft(context(WF, BOTH, store, NOW, () => {}));
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
  assert.equal(sends().filter((h) => h.path.endsWith("/media_publish")).length, 0);
});

test("approval publishes in order, once; a second approve is refused", async () => {
  const store = new MemoryStore();
  await store.put("posts", "morning-1", { id: "morning-1", caption: "Fresh bread at 7am.", image_url: PICTURE, channels: ["instagram", "facebook"], status: "planned" });
  await draft(context(WF, BOTH, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const pubs = hits.filter((h) => h.method === "POST" && !h.path.endsWith("/media"));
  assert.deepEqual(pubs.map((h) => h.path.split("/").pop()), ["media_publish", "photos"]);
  assert.equal(pubs[1].body.url, PICTURE);
  assert.equal(done.results![0].ref!.id, PUBLISHED, "the publish's id is kept on the approval");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("a text-only Facebook post is queued as a Page feed post, never drafted", async () => {
  const store = new MemoryStore();
  await store.put("posts", "news-1", { id: "news-1", caption: "We are open on Monday.", channels: ["facebook"], status: "planned" });
  assert.deepEqual(await draft(context(WF, BOTH, store, NOW, () => {})), { drafted: 0, queued: 1, skipped: 0 });
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "nothing is created or published by the cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["Page.post.feed"]);
  assert.equal(ap.acts[0].input!.params!.message, "We are open on Monday.");
});

test("bad input is skipped before any call: an http link, an empty caption, an Instagram post with no picture", async () => {
  const store = new MemoryStore();
  await store.put("posts", "a-1", { id: "a-1", caption: "x", image_url: "http://images.example.com/a.jpg", channels: ["instagram"], status: "planned" });
  await store.put("posts", "b-1", { id: "b-1", caption: "   ", channels: ["facebook"], status: "planned" });
  await store.put("posts", "c-1", { id: "c-1", caption: "No picture yet", channels: ["instagram"], status: "planned" });
  await store.put("posts", "d-1", { id: "d-1", caption: "x".repeat(2201), channels: ["facebook"], status: "planned" });
  assert.deepEqual(await draft(context(WF, BOTH, store, NOW, () => {})), { drafted: 0, queued: 0, skipped: 4 });
  assert.equal(hits.length, 0, "no call made");
  assert.match((await store.get<any>("posts", "a-1")).reason, /https/);
  assert.match((await store.get<any>("posts", "c-1")).reason, /image_url/);
});

test("a channel the client does not run is not posted to; a post with none of its channels is skipped", async () => {
  const store = new MemoryStore(), fbOnly = { ...BOTH, channels: ["facebook"] };
  await store.put("posts", "ig-only", { id: "ig-only", caption: "x", image_url: PICTURE, channels: ["instagram"], status: "planned" });
  await draft(context(WF, fbOnly, store, NOW, () => {}));
  assert.equal(hits.length, 0);
  assert.equal((await store.get<any>("posts", "ig-only")).status, "skipped");
});

test("a failed container leaves the post planned for the next run, and no approval is queued", async () => {
  const store = new MemoryStore();
  await store.put("posts", "morning-1", { id: "morning-1", caption: "Fresh bread at 7am.", image_url: PICTURE, channels: ["instagram"], status: "planned" });
  postable = false;
  await assert.rejects(draft(context(WF, BOTH, store, NOW, () => {})), /status 400/);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.equal((await store.get<any>("posts", "morning-1")).status, "planned");
});

test("track reads recent posts only and keeps their ids", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await track(context(WF, BOTH, store, NOW, () => {})), { instagram: 2, facebook: 1 });
  assert.ok(hits.every((h) => h.method === "GET"), "reads only");
  const latest = await store.get<any>("history", "latest");
  assert.deepEqual(latest.instagram, ["17900000000000101", "17900000000000102"]);
  assert.deepEqual(latest.facebook, [`${PAGE}_9`]);
});

test("settings with no Page id are refused before any call", async () => {
  const store = new MemoryStore();
  await assert.rejects(draft(context(WF, { ...BOTH, meta: { instagram_user_id: IG } }, store, NOW, () => {})), /facebook_page_id is not set/);
  assert.equal(hits.length, 0);
});

test("deploy: every target renders every cron, with no key values", () => {
  for (const t of TARGETS) {
    const files = render(DIR, BOTH, t);
    const all = Object.values(files).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    assert.ok(!all.includes("test-token-not-real"), `${t} carries no key values`);
  }
});
