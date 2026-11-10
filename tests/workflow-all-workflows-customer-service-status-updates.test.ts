// Status-updates workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { checkStatus, draftUpdates, dailyDigest, CRONS } from "../industries/all/workflows/customer-service/status-updates/index.ts";

const FOLDER = "industries/all/workflows/customer-service/status-updates";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const A = "aaaaaaaa-1111-4222-8333-444444444444", B = "bbbbbbbb-1111-4222-8333-555555555555";
const CO_A = "11111111-aaaa-4bbb-8ccc-222222222222", CO_B = "22222222-aaaa-4bbb-8ccc-333333333333";
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; body: any; filter: string | null };
let hits: Hit[] = [];
let jobs: any[] = [];
let contacts: Record<string, any[]> = {};

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, filter: u.searchParams.get("$filter") });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/job.json")) return json(jobs);
      if (p.endsWith("/companycontact.json")) {
        const co = /company_uuid eq '([^']+)'/.exec(u.searchParams.get("$filter") ?? "")?.[1];
        return json(co ? contacts[co] ?? [] : []);
      }
      if (p.endsWith("/platform_service_sms") || p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /platform_service_(sms|email)$/.test(h.path));
const job = (uuid: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ uuid, status, active: 1, job_address: "1 Test St", company_uuid: CO_A, work_order_date: "2026-11-01", ...extra });
const approvalsOf = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));
const S: any = { channel: "sms", notify_statuses: ["Work Order", "Completed"], business_name: "Test Plumbing", stale_after_days: 7 };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", KIT_ALLOW_WRITES: "1" });
  jobs = [job(A, "Work Order")];
  contacts = { [CO_A]: [{ first: "Sam", last: "Lee", email: "sam@example.com", mobile: "0412 345 678", is_primary_contact: "1" }] };
});

test("runtime: a cron cannot send and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_sms", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.listJobs", summary: "x" }), /not a live operation/);
});

test("first run records a baseline and messages nobody about existing jobs", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  jobs = [job(A, "Work Order"), job(B, "Completed")];
  assert.equal((await checkStatus(ctx) as any).baseline, true);
  assert.deepEqual(await draftUpdates(ctx), { queued: 0, needs_contact: 0, human: 0 });
  assert.equal((await approvalsOf(store)).length, 0);
  assert.equal(sends().length, 0);
});

test("a status change is queued once, never sent until approved, and re-runs never queue twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await checkStatus(ctx);
  jobs = [job(A, "Completed")];
  assert.equal((await checkStatus(ctx) as any).recorded, 1);
  assert.deepEqual(await draftUpdates(ctx), { queued: 1, needs_contact: 0, human: 0 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const [ap] = await approvalsOf(store);
  assert.equal(ap.acts[0].op, "messaging-api.send_sms");
  assert.equal(ap.acts[0].input!.body.to, "+61412345678");
  assert.equal(ap.acts[0].input!.body.regardingJobUUID, A);
  assert.match(ap.acts[0].input!.body.message, /complete/);
  await checkStatus(ctx); await draftUpdates(ctx);
  assert.equal((await approvalsOf(store)).length, 1, "re-runs never queue twice");
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].body.regardingJobUUID, A);
});

test("a client with no mobile gets the email instead, with the name escaped", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  contacts[CO_A] = [{ first: "Sam <b>", last: "Lee", email: "sam@example.com", is_primary_contact: "1" }];
  await checkStatus(ctx);
  jobs = [job(A, "Work Order")]; jobs[0].status = "Work Order";
  await store.put("jobs", A, { status: "Quote", seen: NOW.toISOString() });
  await checkStatus(ctx); await draftUpdates(ctx);
  const [ap] = await approvalsOf(store);
  assert.equal(ap.acts[0].op, "messaging-api.send_email");
  assert.equal(ap.acts[0].input!.body.to, "sam@example.com");
  assert.doesNotMatch(ap.acts[0].input!.body.htmlBody, /<b>/);
});

test("Unsuccessful is never messaged: the change goes to a person", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await checkStatus(ctx);
  jobs = [job(A, "Unsuccessful")];
  await checkStatus(ctx);
  assert.deepEqual(await draftUpdates(ctx), { queued: 0, needs_contact: 0, human: 1 });
  assert.equal((await approvalsOf(store)).length, 0);
  const digest = await dailyDigest(ctx) as any;
  assert.deepEqual(digest.for_a_person.map((p: any) => p.job), [A]);
});

test("no usable contact parks the change and queues nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  contacts = {};
  await checkStatus(ctx);
  jobs = [job(A, "Completed")];
  await checkStatus(ctx);
  assert.deepEqual(await draftUpdates(ctx), { queued: 0, needs_contact: 1, human: 0 });
  assert.equal((await approvalsOf(store)).length, 0);
});

test("bad job ids and unknown statuses are dropped before they reach a filter or the store", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  jobs = [{ uuid: "x' or 1=1", status: "Completed", active: 1 }, { uuid: A, status: "Mystery", active: 1 }];
  await checkStatus(ctx);
  assert.equal(Object.keys(await store.list("jobs")).length, 0);
  assert.equal(hits.some((h) => h.path.endsWith("/companycontact.json")), false);
});

test("the digest is store only: nothing is sent and the stale work order is listed", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  jobs = [job(A, "Work Order", { work_order_date: "2026-10-01" })];
  const digest = await dailyDigest(ctx) as any;
  assert.equal(digest.stale.length, 1);
  assert.equal(sends().length, 0);
  assert.equal((await approvalsOf(store)).length, 0);
});

test("cron entries in workflow.json match the exported CRONS", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ((WF as any).crons as { entry: string }[]).map((c) => c.entry).sort());
});
