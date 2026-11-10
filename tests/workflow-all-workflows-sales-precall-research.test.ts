// Pre-call research workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { describe } from "../core/sdk/call.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { prep, refresh, queue, CRONS } from "../industries/all/workflows/sales/precall-research/index.ts";
import { checkSettings, type Settings, type Brief } from "../industries/all/workflows/sales/precall-research/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/precall-research/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const DAY = 864e5;
const S: Settings = { window_days: 14, max_deals: 10, use_apollo: true };
const ORG = "5e66b6381e05b4008c8331b8";
const DEAL_PATCH = "crm-deals-2026-09.patch-/crm/objects/2026-09/0-3/{dealId}_/crm/objects/2026-09-beta/{objectType}/{objectId}";
const DEAL_SEARCH = "crm-deals-2026-09.post-/crm/objects/2026-09/0-3/search_/crm/objects/2026-09-beta/{objectType}/search";

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let deals: any[] = [];
let assoc: Record<string, string[]> = {};
let contacts: Record<string, Record<string, string>> = {};
let companies: Record<string, Record<string, string>> = {};
let apolloOrg: Record<string, unknown> = {};
let news: any[] = [];
let jobs: any[] = [];
let noteSeq = 9000;

function fixtures() {
  deals = [{ id: "501", properties: { dealname: "Acme <b>renewal</b>", dealstage: "qualifiedtobuy", closedate: String(NOW.getTime() + 3 * DAY), amount: "12000" } }];
  assoc = { "501:contacts": ["701"], "501:companies": ["801"] };
  contacts = { "701": { firstname: "Sam", lastname: "Lee", jobtitle: "Ops Manager", email: "sam@acme.example" } };
  companies = { "801": { name: "Acme Pty Ltd", domain: "https://www.acme.example/about", industry: "Construction", numberofemployees: "45", description: "Family firm that builds <things>" } };
  apolloOrg = { id: ORG, name: "Acme", industry: "Construction", estimated_num_employees: 50, short_description: "Family firm", city: "Perth", country: "Australia" };
  news = [{ title: "Acme wins tender", url: "https://news.example/acme", published_at: "2026-11-01T00:00:00Z" }, { title: "Unsafe link", url: "javascript:alert(1)" }];
  jobs = [{ title: "Estimator", posted_at: "2026-11-02T00:00:00Z", city: "Perth", state: "WA", country: "Australia" }];
}

function fake() {
  hits = []; noteSeq = 9000;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      const missing = () => new Response("missing", { status: 404 });
      // HubSpot
      if (p === "/crm/objects/2026-09/0-3/search" && m === "POST") return json({ results: deals });
      const a = /^\/crm\/objects\/2026-09\/0-3\/([^/]+)\/associations\/(contacts|companies)$/.exec(p);
      if (a && m === "GET") return json({ results: (assoc[`${a[1]}:${a[2]}`] ?? []).map((id) => ({ toObjectId: id, associationTypes: [] })) });
      const c = /^\/crm\/v3\/objects\/contacts\/([^/]+)$/.exec(p);
      if (c && m === "GET") return contacts[c[1]] ? json({ id: c[1], properties: contacts[c[1]] }) : missing();
      const co = /^\/crm\/objects\/2026-09\/companies\/([^/]+)$/.exec(p);
      if (co && m === "GET") return companies[co[1]] ? json({ id: co[1], properties: companies[co[1]] }) : missing();
      if (p === "/crm/objects/2026-09/notes" && m === "POST") return json({ id: String(++noteSeq) });
      if (/^\/crm\/objects\/2026-09\/notes\/\d+\/associations\/default\/0-3\/\d+$/.test(p) && m === "PUT") return json({});
      if (/^\/crm\/objects\/2026-09\/0-3\/\d+$/.test(p) && m === "PATCH") return json({ id: p.split("/").pop() });
      // Apollo
      if (p === "/api/v1/people/match" && m === "POST") return json({ person: { title: "Operations Director", headline: "Runs ops at Acme", email: "private@acme.example" } });
      if (p === "/api/v1/organizations/enrich" && m === "GET") return json({ organization: apolloOrg });
      if (p === "/api/v1/news_articles/search" && m === "POST") return json({ news_articles: news });
      if (p === `/api/v1/organizations/${ORG}/job_postings` && m === "GET") return json({ organization_job_postings: jobs });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const ctxFor = (s: Settings, store: MemoryStore, now = NOW) => context(WF, s, store, now, () => {});
const approvals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));
const briefOf = async (store: MemoryStore, id = "501") => store.get<Brief>("briefs", id);
/** Anything sent to a platform that changes data: a create, an update, a link. */
const writes = () => hits.filter((h) => h.method !== "GET" && !(h.method === "POST" && (h.path.endsWith("/search") || h.path.endsWith("/people/match") || h.path.endsWith("/news_articles/search"))));
const notes = () => hits.filter((h) => h.method === "POST" && h.path === "/crm/objects/2026-09/notes");
const apolloCalls = () => hits.filter((h) => h.path.startsWith("/api/v1/"));

beforeEach(() => {
  fake(); fixtures();
  Object.assign(process.env, { HUBSPOT_ACCESS_TOKEN: "hs-test", APOLLO_API_KEY: "ap-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run the deal update as a draft, and cannot queue a read", async () => {
  const ctx = ctxFor(S, new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "hubspot", op: DEAL_PATCH, summary: "x", input: { params: { dealId: "501" }, body: {} } }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "hubspot", op: DEAL_SEARCH, key: "k", summary: "x", input: {} }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("every draft and live operation in workflow.json is mapped in the kit", () => {
  for (const [platform, ops] of Object.entries({ ...WF.draft_ops, ...WF.live_ops })) for (const op of ops) assert.doesNotThrow(() => describe(platform, op), `${platform} ${op}`);
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `cron ${c.name} has an entry`);
});

test("prep: briefs the deal, writes one internal note, reads everything else, and never updates the deal", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await prep(ctxFor(S, store)), { deals: 1, briefed: 1, noted: 1 });
  assert.equal(writes().filter((h) => h.method === "PATCH").length, 0, "no deal change by a cron");
  assert.equal(notes().length, 1, "one note");
  assert.equal(hits.filter((h) => h.path === "/crm/objects/2026-09/notes/9001/associations/default/0-3/501" && h.method === "PUT").length, 1, "note linked to the deal");
  const search = hits.find((h) => h.path === "/crm/objects/2026-09/0-3/search")!.body;
  assert.equal(search.filterGroups[0].filters[0].operator, "BETWEEN");
  assert.deepEqual(search.filterGroups[0].filters[1].values, ["closedwon", "closedlost"]);
  const html = notes()[0].body.properties.hs_note_body as string;
  assert.match(html, /Acme &lt;b&gt;renewal&lt;\/b&gt;/, "the deal name is escaped");
  assert.match(html, /Family firm that builds &lt;things&gt;/, "the company description is escaped");
  assert.doesNotMatch(html, /javascript:|sam@acme\.example|private@acme\.example/, "no unsafe link and no email in the note");
  assert.match(html, /Acme wins tender/);
  assert.match(html, /Estimator/);
  const b = (await briefOf(store))!;
  assert.equal(b.apollo_org_id, ORG);
  assert.equal(b.company?.domain, "acme.example");
  assert.equal(b.news.length, 1, "the javascript link is dropped");
  assert.equal(b.noteLinked, true);
  assert.ok(b.questions.length >= 2 && b.questions.length <= 4);
});

test("prep: the person match never reveals personal email or phone", async () => {
  await prep(ctxFor(S, new MemoryStore()));
  const pm = hits.find((h) => h.path === "/api/v1/people/match")!;
  assert.equal(pm.query.get("email"), "sam@acme.example");
  assert.equal(pm.query.get("reveal_personal_emails"), null);
  assert.equal(pm.query.get("reveal_phone_number"), null);
  assert.equal(pm.query.get("run_waterfall_email"), null);
});

test("prep: a second run never writes a second note, and does not re-enrich inside a week", async () => {
  const store = new MemoryStore();
  await prep(ctxFor(S, store));
  const before = apolloCalls().length;
  await prep(ctxFor(S, store, new Date(NOW.getTime() + DAY)));
  assert.equal(notes().length, 1, "one note in total");
  assert.equal(apolloCalls().length, before, "no Apollo call inside a week");
});

test("prep: a note created but not yet linked is linked on the next run, not created again", async () => {
  const store = new MemoryStore();
  await prep(ctxFor({ ...S, use_apollo: false }, store));
  const b = (await briefOf(store))!;
  await store.put("briefs", "501", { ...b, noteLinked: false });
  hits = [];
  await prep(ctxFor({ ...S, use_apollo: false }, store, new Date(NOW.getTime() + DAY)));
  assert.equal(notes().length, 0, "no new note");
  assert.equal(hits.filter((h) => h.method === "PUT").length, 1, "linked once");
});

test("prep: Apollo off keeps the brief to HubSpot data, and the note is still written", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await prep(ctxFor({ ...S, use_apollo: false }, store)), { deals: 1, briefed: 1, noted: 1 });
  assert.equal(apolloCalls().length, 0, "no Apollo call at all");
  const b = (await briefOf(store))!;
  assert.equal(b.apollo_org_id, undefined);
  assert.equal(b.news.length, 0);
  assert.equal(notes().length, 1);
});

test("prep: an invalid contact email never goes to Apollo, but the company domain still does", async () => {
  contacts["701"].email = "not-an-email";
  await prep(ctxFor(S, new MemoryStore()));
  const pm = hits.find((h) => h.path === "/api/v1/people/match")!;
  assert.equal(pm.query.get("email"), null);
  assert.equal(pm.query.get("domain"), "acme.example");
});

test("prep: ids that are not digits are dropped before any call is made", async () => {
  deals = [{ id: "5x1", properties: { dealname: "Bad id", dealstage: "x", closedate: String(NOW.getTime() + DAY) } }];
  assert.deepEqual(await prep(ctxFor(S, new MemoryStore())), { deals: 0, briefed: 0, noted: 0 });
  assert.equal(notes().length, 0);
  deals = [{ id: "501", properties: { dealname: "Ok", dealstage: "x", closedate: String(NOW.getTime() + DAY) } }];
  assoc = { "501:contacts": ["abc"], "501:companies": [] };
  await prep(ctxFor({ ...S, use_apollo: false }, new MemoryStore()));
  assert.equal(hits.filter((h) => h.path.startsWith("/crm/v3/objects/contacts/")).length, 0, "a non-digit contact id is never read");
});

test("refresh: re-reads news and hiring for open briefs, stores them, and writes nothing to the CRM", async () => {
  const store = new MemoryStore();
  await prep(ctxFor(S, store));
  news = [{ title: "Acme opens a second yard", url: "https://news.example/yard", published_at: "2026-11-07T00:00:00Z" }];
  hits = [];
  assert.deepEqual(await refresh(ctxFor(S, store, new Date(NOW.getTime() + DAY))), { refreshed: 1 });
  assert.equal(writes().length, 0, "refresh never writes");
  assert.equal((await briefOf(store))!.news[0].title, "Acme opens a second yard");
});

test("refresh: does nothing when Apollo is off", async () => {
  assert.deepEqual(await refresh(ctxFor({ ...S, use_apollo: false }, new MemoryStore())), { refreshed: 0 });
  assert.equal(hits.length, 0);
});

test("queue: one next-step change per brief waits for approval, and an approval runs it once", async () => {
  const store = new MemoryStore();
  await prep(ctxFor(S, store));
  assert.deepEqual(await queue(ctxFor(S, store)), { queued: 1 });
  assert.equal(hits.filter((h) => h.method === "PATCH").length, 0, "queued, not run");
  const [ap] = await approvals(store);
  assert.equal(ap.status, "pending");
  assert.match(ap.acts[0].input!.body.properties.hs_next_step, /^Before the call: /);
  await queue(ctxFor(S, store));
  assert.equal((await approvals(store)).length, 1, "a re-run never queues the same change twice");
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const patch = hits.find((h) => h.method === "PATCH")!;
  assert.equal(patch.path, "/crm/objects/2026-09/0-3/501");
  assert.equal(patch.body.properties.hs_next_step.startsWith("Before the call: "), true);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("queue: a brief whose note is not linked yet queues nothing", async () => {
  const store = new MemoryStore();
  await prep(ctxFor({ ...S, use_apollo: false }, store));
  await store.put("briefs", "501", { ...(await briefOf(store))!, noteLinked: false });
  assert.deepEqual(await queue(ctxFor(S, store)), { queued: 0 });
});

test("settings are refused before any call when they cannot run", () => {
  assert.throws(() => checkSettings({ ...S, window_days: 0 }), /window_days/);
  assert.throws(() => checkSettings({ ...S, max_deals: 99 }), /max_deals/);
  assert.throws(() => checkSettings({ ...S, use_apollo: "yes" as unknown as boolean }), /use_apollo/);
  assert.doesNotThrow(() => checkSettings(S));
});

test("the write gate still blocks the deal search and the note when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  await assert.rejects(prep(ctxFor(S, new MemoryStore())), WriteBlocked);
  assert.equal(hits.length, 0, "refused before a socket opens");
});
