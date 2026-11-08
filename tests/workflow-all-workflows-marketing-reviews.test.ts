// Reviews workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { reviews, ask, CRONS } from "../industries/all/workflows/marketing/reviews/index.ts";

const DIR = "industries/all/workflows/marketing/reviews";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const LOC = "11111111-2222-4333-8444-555555555555";
const REV1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";   // five stars, needs a reply
const REV2 = "99999999-8888-4777-8666-555555555555";   // one star, needs a reply, flagged
const REV3 = "12345678-1234-4234-8234-123456789012";   // already answered
const INVITE = "87654321-4321-4321-8321-210987654321";
const CONTACT = "Ab12Cd34Ef56Gh78Ij90";
const PS: any = { business_name: "Test Plumbing", review_platform: "podium", podium: { location_uid: LOC }, low_rating_max: 3 };
const GS: any = { business_name: "Test Plumbing", review_platform: "gohighlevel", gohighlevel: { review_workflow_id: "wf_review_1", asked_tag: "review-asked" } };

type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];
let reviewsList: any[] = [];

function fake() {
  hits = [];
  reviewsList = [
    { uid: REV1, needsResponse: true, review: { rating: 5, body: "Great job" }, author: { name: "Ari Lee" }, createdAt: "2026-11-07T10:00:00Z" },
    { uid: REV2, needsResponse: true, review: { rating: 1, body: "Late and rude" }, author: { name: "Sam" }, createdAt: "2026-11-07T11:00:00Z" },
    { uid: REV3, needsResponse: false, review: { rating: 4, body: "Fine" }, author: { name: "Jo" }, createdAt: "2026-11-06T09:00:00Z" },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/v4/reviews" && m === "GET") return json({ data: reviewsList, metadata: {} });
      if (p === "/v4/reviews/invites" && m === "POST") return json({ data: { uid: INVITE, deliveryStatus: "sent" }, metadata: {} });
      if (p === `/contacts/${CONTACT}/workflow/wf_review_1` && m === "POST") return json({ succeeded: true });
      if (p === `/contacts/${CONTACT}/tags` && m === "POST") return json({ tags: ["review-asked"] });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const posts = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PODIUM_ACCESS_TOKEN: "p", GHL_ACCESS_TOKEN: "g", KIT_ALLOW_WRITES: "1" });
});

test("the crons are the two declared in workflow.json", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["ask", "reviews"]);
  for (const c of WF.crons) assert.ok(CRONS[c.entry], `cron ${c.entry} has no function`);
});

test("runtime: a cron cannot draft a live operation and cannot queue a read", async () => {
  const ctx = context(WF, PS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "podium", op: "docs.post_reviews_invites", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "podium", op: "docs.get_reviews", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("reviews drafts a reply for each unanswered review, flags the low one, and posts nothing", async () => {
  const store = new MemoryStore();
  const out = await reviews(context(WF, PS, store, NOW, () => {}));
  assert.deepEqual(out, { read: 3, drafted: 2, flagged: 1 });
  const d = await store.list<any>("reply_drafts");
  assert.deepEqual(Object.keys(d).sort(), [REV1, REV2].sort());
  assert.equal(d[REV2].flagged, true);
  assert.equal(d[REV1].flagged, false);
  assert.equal(posts().length, 0, "nothing posted");
  assert.equal(hits.length, 1, "one read only");
  assert.equal(hits[0].search, "?limit=50");
});

test("reviews run again without drafting the same reply twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, PS, store, NOW, () => {});
  await reviews(ctx);
  assert.deepEqual(await reviews(ctx), { read: 3, drafted: 0, flagged: 0 });
});

test("ask queues a Podium invite for a completed job; nothing goes out until approved; a re-run never queues twice", async () => {
  const store = new MemoryStore();
  await store.put("completed_jobs", "job-1", { id: "job-1", name: "Ari Lee", phone: "+61412345678", completed_at: "2026-11-07T09:00:00Z" });
  const ctx = context(WF, PS, store, NOW, () => {});
  assert.deepEqual(await ask(ctx), { queued: 1, skipped: 0 });
  assert.deepEqual(await ask(ctx), { queued: 0, skipped: 0 });
  assert.equal(posts().length, 0, "queued, not sent");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].acts[0].op, "docs.post_reviews_invites");
  const done = await approve(WF, store, approvals[0].id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].path, "/v4/reviews/invites");
  assert.deepEqual(posts()[0].body, { locationUid: LOC, phoneNumber: "+61412345678" });
});

test("ask falls back to email when there is no usable phone, and records why a job cannot be asked", async () => {
  const store = new MemoryStore();
  await store.put("completed_jobs", "job-2", { id: "job-2", email: "jo@example.com", phone: "0412 345 678", completed_at: "2026-11-07T09:00:00Z" });
  await store.put("completed_jobs", "job-3", { id: "job-3", completed_at: "2026-11-07T10:00:00Z" });
  const out = await ask(context(WF, PS, store, NOW, () => {}));
  assert.deepEqual(out, { queued: 1, skipped: 1 });
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts[0].input, { body: { locationUid: LOC, email: "jo@example.com" } });
  const j3 = (await store.get<any>("completed_jobs", "job-3"))!;
  assert.match(j3.problem, /no usable phone or email/);
  assert.equal(posts().length, 0);
});

test("the store refuses a job key that is not safe, so ask never sees one", async () => {
  const store = new MemoryStore();
  await assert.rejects(store.put("completed_jobs", "bad id/../x", { id: "bad id/../x", phone: "+61412345678", completed_at: "2026-11-07T09:00:00Z" }), /bad store name/);
  assert.deepEqual(await ask(context(WF, PS, store, NOW, () => {})), { queued: 0, skipped: 0 });
  assert.equal(posts().length, 0);
});

test("gohighlevel: the review workflow and the asked tag are one approval, and run in order on approval", async () => {
  const store = new MemoryStore();
  await store.put("completed_jobs", "job-5", { id: "job-5", name: "Jo", email: "jo@example.com", contact_id: CONTACT, completed_at: "2026-11-07T09:00:00Z" });
  const ctx = context(WF, GS, store, NOW, () => {});
  assert.deepEqual(await ask(ctx), { queued: 1, skipped: 0 });
  assert.equal(posts().length, 0, "queued, not sent");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["contacts.add-contact-to-workflow", "contacts.add-tags"]);
  await approve(WF, store, ap.id, "owner", NOW);
  assert.deepEqual(posts().map((h) => h.path), [`/contacts/${CONTACT}/workflow/wf_review_1`, `/contacts/${CONTACT}/tags`]);
  assert.deepEqual(posts()[1].body, { tags: ["review-asked"] });
});

test("gohighlevel has no review read: reviews reads nothing and drafts nothing", async () => {
  assert.deepEqual(await reviews(context(WF, GS, new MemoryStore(), NOW, () => {})), { read: 0, drafted: 0, flagged: 0 });
  assert.equal(hits.length, 0);
});

test("bad settings stop both crons before any call", async () => {
  const noLoc = { ...PS, podium: { location_uid: "not-a-uid" } };
  await assert.rejects(reviews(context(WF, noLoc, new MemoryStore(), NOW, () => {})), /podium.location_uid/);
  await assert.rejects(ask(context(WF, { ...GS, gohighlevel: {} }, new MemoryStore(), NOW, () => {})), /review_workflow_id/);
  assert.equal(hits.length, 0);
});
