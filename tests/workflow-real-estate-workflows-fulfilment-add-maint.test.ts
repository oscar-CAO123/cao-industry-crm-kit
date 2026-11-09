// Maintenance dispatch workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, dispatch, followUp } from "../industries/real-estate/workflows/fulfilment/add-maint/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/fulfilment/add-maint/workflow.json", "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", CO = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", STAFF = "99999999-8888-4777-8666-555555555555";
const ALLOC = "12345678-1234-4234-8234-123456789012";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let jobStatus = "Quote", jobDesc = "Hot water system leaking", allocated = false, staffActive = true;

function fake() {
  hits = []; jobStatus = "Quote"; jobDesc = "Hot water system leaking"; allocated = false; staffActive = true;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname, f = u.searchParams.get("$filter") ?? "";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      const job = { uuid: JOB, status: jobStatus, active: 1, job_description: jobDesc, job_address: "1 Test St", company_uuid: CO, date: "2026-11-08" };
      if (p.endsWith("/job.json") && m === "GET") {
        if (f.includes("uuid eq")) return json([{ ...job }]);
        if (f.includes("status eq 'Work Order'")) return json(jobStatus === "Work Order" || jobStatus === "Completed" ? [job] : []);
        if (f.includes("status eq 'Quote'")) return json(jobStatus === "Quote" ? [job] : []);
      }
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", mobile: "0412 345 678", is_primary_contact: "1" }]);
      if (p.endsWith("/staff.json")) return json(staffActive ? [{ uuid: STAFF, active: 1 }] : []);
      if (p.endsWith("/joballocation.json") && m === "GET") return json(allocated ? [{ uuid: ALLOC, active: 1 }] : []);
      if (p.endsWith("/joballocation.json") && m === "POST") { allocated = true; return json({ errorCode: 0 }, { "x-record-uuid": ALLOC }); }
      if (p.endsWith("/platform_service_email") || p.endsWith("/platform_service_sms")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const allocs = () => hits.filter((h) => h.path.endsWith("/joballocation.json") && h.method === "POST");
const sends = () => hits.filter((h) => /platform_service_(email|sms)$/.test(h.path));
const S: any = { business_name: "Test PM", platform: "servicem8", dispatch_staff_uuid: STAFF, owner_email: "owner@example.com", follow_up: { after_days: [2, 5] } };
const NOW = new Date("2026-11-08T00:00:00Z");
const servicem8Act = () => ({ platform: "servicem8", op: "servicem8-api.createJobAllocations", key: `dispatch:${JOB}`, summary: "allocate", input: { body: { job_uuid: JOB, staff_uuid: STAFF } } });
const DAY = 864e5;

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation, and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "servicem8-api.createJobAllocations", input: { body: {} }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.listJobs", summary: "x" }), /not a live operation/);
});

test("runtime: the SDK gate blocks an approved allocation when the deploy does not allow writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await ctx.queue(servicem8Act());
  process.env.KIT_ALLOW_WRITES = "0";
  const ap = await approve(WF, store, approvalId(WF.id, `dispatch:${JOB}`), "oscar", NOW);
  assert.equal(ap.status, "failed");
  assert.match(ap.error ?? "", /write|WriteBlocked|KIT_ALLOW_WRITES/i);
  assert.equal(allocs().length, 0, "no allocation reached the platform");
});

test("intake records a new request from a Quote-status job, and reads only", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await intake(ctx), { added: 0 }, "a second run adds nothing");
  const rec = await store.get<any>("jobs", JOB);
  assert.equal(rec.status, "new");
  assert.equal(rec.contact.email, "sam@example.com");
  assert.equal(rec.contact.phone, "+61412345678");
  assert.equal(allocs().length + sends().length, 0, "nothing allocated or sent");
});

test("dispatch queues one allocation for an approved job and never allocates it itself", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  jobStatus = "Work Order";
  assert.deepEqual(await dispatch(ctx), { queued: 1 });
  assert.equal(allocs().length, 0, "the cron does not allocate");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1);
  assert.deepEqual(await dispatch(ctx), { queued: 0 }, "a re-run never queues the same job twice");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1);
});

test("an approved allocation runs once and records the job as dispatched", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  jobStatus = "Work Order";
  await dispatch(ctx);
  const id = approvalId(WF.id, `dispatch:${JOB}`);
  const ap = await approve(WF, store, id, "oscar", NOW);
  assert.equal(ap.status, "done");
  assert.deepEqual(allocs().at(-1)!.body, { job_uuid: JOB, staff_uuid: STAFF });
  await assert.rejects(approve(WF, store, id, "oscar"), /already done/);
  await followUp(ctx);
  assert.equal((await store.get<any>("jobs", JOB)).status, "in-work");
});

test("a job already allocated by hand is recorded as in work, not queued again", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  jobStatus = "Work Order"; allocated = true;
  assert.deepEqual(await dispatch(ctx), { queued: 0 });
  assert.equal((await store.get<any>("jobs", JOB)).status, "in-work");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("a dispatch staff member who is not active stops the cron before anything is queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  staffActive = false; jobStatus = "Work Order";
  await assert.rejects(dispatch(ctx), /not an active ServiceM8 staff member/);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("completion queues the owner update for approval, with the description escaped", async () => {
  jobDesc = `<img src=x onerror="alert(1)"> Leaking & dripping`;
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  jobStatus = "Work Order";
  await dispatch(ctx);
  await approve(WF, store, approvalId(WF.id, `dispatch:${JOB}`), "oscar", NOW);
  await followUp(ctx);
  jobStatus = "Completed";
  assert.deepEqual(await followUp(ctx), { queued: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const ownerAp = await store.get<Approval>("approvals", approvalId(WF.id, `owner-update:${JOB}`));
  assert.ok(ownerAp, "owner update queued");
  assert.equal(ownerAp!.acts[0].input.body.to, "owner@example.com");
  assert.ok(!ownerAp!.acts[0].input.body.htmlBody.includes("<img"), "description is escaped");
  assert.equal((await store.get<any>("jobs", JOB)).reported !== undefined, true);
  await followUp(ctx);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).filter((k) => k.includes("owner-update")).length, 1);
});

test("a stalled job gets one progress check per step, queued for approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  jobStatus = "Work Order";
  await dispatch(ctx);
  await approve(WF, store, approvalId(WF.id, `dispatch:${JOB}`), "oscar", NOW);
  await followUp(ctx);                        // dispatched on NOW, nothing due yet
  const later = new Date(NOW.getTime() + 2 * DAY);
  const laterCtx = context(WF, S, store, later, () => {});
  assert.deepEqual(await followUp(laterCtx), { queued: 1 });
  assert.equal(sends().length, 0);
  const ap = await store.get<Approval>("approvals", approvalId(WF.id, `follow1:${JOB}`));
  assert.equal(ap!.acts[0].op, "messaging-api.send_email");
  assert.equal(ap!.acts[0].input.body.to, "sam@example.com");
  assert.deepEqual(await followUp(laterCtx), { queued: 0 }, "the same step is not queued twice");
});

test("a text progress check goes out as an SMS to an Australian mobile when the channel is sms", async () => {
  const store = new MemoryStore();
  const smsCtx = context(WF, { ...S, follow_up: { after_days: [2], channel: "sms" } }, store, NOW, () => {});
  await intake(smsCtx);
  jobStatus = "Work Order";
  await dispatch(smsCtx);
  await approve(WF, store, approvalId(WF.id, `dispatch:${JOB}`), "oscar", NOW);
  const later = context(WF, { ...S, follow_up: { after_days: [2], channel: "sms" } }, store, new Date(NOW.getTime() + 3 * DAY), () => {});
  assert.deepEqual(await followUp(later), { queued: 1 });
  const ap = await store.get<Approval>("approvals", approvalId(WF.id, `follow1:${JOB}`));
  assert.equal(ap!.acts[0].op, "messaging-api.send_sms");
  assert.equal(ap!.acts[0].input.body.to, "+61412345678");
});

test("an owner update subject is one line even when the tenant's job title has line breaks", async () => {
  jobDesc = "Hot water\r\nBcc: someone@example.com\nleaking";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  jobStatus = "Work Order";
  await dispatch(ctx);
  await approve(WF, store, approvalId(WF.id, `dispatch:${JOB}`), "oscar", NOW);
  await followUp(ctx);
  jobStatus = "Completed";
  assert.deepEqual(await followUp(ctx), { queued: 1 });
  const ownerAp = await store.get<Approval>("approvals", approvalId(WF.id, `owner-update:${JOB}`));
  const subject: string = ownerAp!.acts[0].input.body.subject;
  assert.ok(!/[\r\n]/.test(subject), "no line break in the subject");
  assert.equal(subject, "Maintenance complete: Hot water Bcc: someone@example.com leaking");
});
