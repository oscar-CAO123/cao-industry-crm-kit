// Landing-pages workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { inventory, results, queue } from "../industries/all/workflows/marketing/landing-pages/index.ts";
import type { Change } from "../industries/all/workflows/marketing/landing-pages/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/marketing/landing-pages/workflow.json", "utf8")) as WorkflowRecord;
const SITE = "64a1b2c3d4e5f60718293a4b", PAGE = "64a1b2c3d4e5f60718293a4c", FORM = "64a1b2c3d4e5f60718293a4d";
const LOC = "ojQjykmwNIU88vfsfzvH", FUNNEL = "iucJ6TdFZiddhq9f6znh", GFORM = "gFormId12345678";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let failPublish = 0;

function fake() {
  hits = []; failPublish = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // Webflow
      if (p.endsWith(`/sites/${SITE}/pages`)) return json({ pages: [{ id: PAGE, title: "Summer event", slug: "summer" }], pagination: {} });
      if (p.endsWith(`/sites/${SITE}/forms`)) return json({ forms: [{ id: FORM, displayName: "Enquiry form" }], pagination: {} });
      if (p.endsWith(`/forms/${FORM}/submissions`)) return json({ formSubmissions: [
        { id: "s1", dateSubmitted: "2026-11-07T10:00:00.000Z" }, { id: "s2", dateSubmitted: "2026-10-01T10:00:00.000Z" }], pagination: {} });
      if (p.endsWith(`/pages/${PAGE}/dom`)) return json({ errors: [] });
      if (p.endsWith(`/sites/${SITE}/publish`)) {
        if (failPublish-- > 0) return new Response("{}", { status: 500 });
        return json({ publishScope: "page" });
      }
      // GoHighLevel
      if (p.endsWith("/funnels/funnel/list")) return json({ funnels: [{ _id: FUNNEL, name: "Event funnel", locationId: LOC }], count: 1 });
      if (p.endsWith("/funnels/page")) return json([{ _id: "pg00000000000001", name: "Home", funnelId: FUNNEL }]);
      if (p.endsWith("/forms/")) return json({ forms: [{ id: GFORM, name: "Lead form", locationId: LOC }], total: 1 });
      if (p.endsWith("/forms/submissions")) return json({ submissions: [{ id: "x1", createdAt: "2026-11-06T00:00:00Z", formId: GFORM }], meta: {} });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const S: any = { business_name: "Test Events", webflow: { site_id: SITE, locale_id: "en" }, gohighlevel: { location_id: LOC }, results_days: 7 };
const NOW = new Date("2026-11-08T00:00:00Z");
const change = (over: Partial<Change> = {}): Change => ({
  id: "chg-summer-1", platform: "webflow", page_id: PAGE, nodes: [{ id: "hero", text: "Summer event tickets" }],
  publish: true, requested: NOW.toISOString(), status: "requested", ...over,
});

beforeEach(() => {
  fake();
  Object.assign(process.env, { WEBFLOW_API_TOKEN: "wf-test", GHL_ACCESS_TOKEN: "ghl-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "webflow", op: "2.sites_publish", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "webflow", op: "2.pages_update-static-content", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "webflow", op: "2.pages_list", summary: "x" }), /not a live operation/);
});

test("inventory and results only read: every request is a GET, and the figures are kept in the store", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await inventory(ctx), { pages: 2, forms: 2 });
  assert.deepEqual(await results(ctx), { forms: 2 });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.method === "GET"), "no write from a read cron");
  const counts = Object.values(await store.list<any>("results")).map((r) => [r.platform, r.submissions]).sort();
  assert.deepEqual(counts, [["gohighlevel", 1], ["webflow", 1]], "only the submission inside the window counts");
});

test("a requested change is queued, never sent; re-runs queue nothing new", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("changes", "chg-summer-1", change());
  assert.deepEqual(await queue(ctx), { queued: 1, skipped: 0 });
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "nothing written by a cron");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].acts.map((a) => a.op), ["2.pages_update-static-content", "2.sites_publish"]);
  await queue(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "a re-run never queues twice");
  assert.equal((await store.get<Change>("changes", "chg-summer-1"))!.status, "queued");
});

test("approval runs the content update, then the publish of that page, once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("changes", "chg-summer-1", change());
  await queue(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const writes = hits.filter((h) => h.method === "POST");
  assert.deepEqual(writes.map((h) => h.path.split("/").slice(-2).join("/")), [`${PAGE}/dom`, `${SITE}/publish`]);
  assert.deepEqual(writes[0].body, { nodes: [{ id: "hero", text: "Summer event tickets" }] });
  assert.equal(writes[1].body.pageId, PAGE);
  assert.equal(writes[1].body.publishToWebflowSubdomain, true);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("a failed publish resumes without repeating the content update", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("changes", "chg-summer-2", change({ id: "chg-summer-2" }));
  await queue(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  failPublish = 1;
  // A 500 may have been processed by the app: the approval waits for a person to check, and nothing resends on its own.
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "needs-check");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /needs a check/, "approving again without a confirmation sends nothing");
  assert.equal((await approve(WF, store, ap.id, "owner", NOW, "retry")).status, "done");
  const contentUpdates = hits.filter((h) => h.method === "POST" && h.path.endsWith(`${PAGE}/dom`));
  assert.equal(contentUpdates.length, 1, "the content update went once across the retry");
});

test("a change with a bad id or no nodes is skipped with the reason, and nothing is queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("changes", "bad-page", change({ id: "bad-page", page_id: "../../etc" }));
  await store.put("changes", "no-nodes", change({ id: "no-nodes", nodes: [] }));
  assert.deepEqual(await queue(ctx), { queued: 0, skipped: 2 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.match((await store.get<Change>("changes", "bad-page"))!.reason!, /not a Webflow page id/);
});
