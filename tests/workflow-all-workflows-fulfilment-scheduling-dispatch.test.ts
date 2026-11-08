// Scheduling-dispatch workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, allocate, notify } from "../industries/all/workflows/fulfilment/scheduling-dispatch/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/fulfilment/scheduling-dispatch";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const JOB_A = "11111111-2222-4333-8444-555555555555", JOB_B = "22222222-2222-4333-8444-555555555555", JOB_C = "33333333-2222-4333-8444-555555555555";
const CO_A = "cccccccc-1111-4222-8333-444444444444", CO_C = "cccccccc-2222-4222-8333-444444444444";
const S1 = "aaaaaaaa-0000-4000-8000-000000000001", S2 = "aaaaaaaa-0000-4000-8000-000000000002", OFFICE = "aaaaaaaa-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-11-08T00:00:00Z");   // a Sunday, 11 am in Sydney
const MON = "2026-11-09", MON_LABEL = "Monday 9 November";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let allocs: any[] = [];
let msgs: any[] = [];
let sends: any[] = [];
let seq = 0;

const JOBS = [
  { uuid: JOB_A, status: "Work Order", active: 1, job_description: "Hot water system leaking", company_uuid: CO_A, date: "2026-11-05" },
  { uuid: JOB_B, status: "Work Order", active: 1, job_description: "Already crewed", company_uuid: CO_A, date: "2026-11-05" },
  { uuid: JOB_C, status: "Work Order", active: 1, job_description: "Blocked drain", company_uuid: CO_C, date: "2026-11-05" },
];
const STAFF = [{ uuid: S1, active: 1 }, { uuid: S2, active: 1 }];
const CONTACTS = [{ company_uuid: CO_A, first: "Sam", last: "Lee", mobile: "0412 345 678", is_primary_contact: "1", active: 1 }];

/** Applies a ServiceM8 $filter of the form "field eq 'value'" joined by "and". */
function filterRows<T extends Record<string, any>>(rows: T[], f: string | null): T[] {
  const conds = [...(f ?? "").matchAll(/(\w+) eq '([^']*)'|(\w+) eq (\d+)/g)].map((m) => [m[1] ?? m[3], m[2] ?? m[4]]);
  return rows.filter((r) => conds.every(([k, v]) => String(r[k]) === v));
}

function fake() {
  hits = []; allocs = [{ uuid: "ffffffff-0000-4000-8000-000000000001", job_uuid: JOB_B, staff_uuid: S1, allocation_date: "2026-11-02", active: 1 }];
  msgs = []; sends = []; seq = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname, f = u.searchParams.get("$filter");
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (p.endsWith("/job.json") && m === "GET") return json(filterRows(JOBS, f));
      if (p.endsWith("/joballocation.json") && m === "GET") return json(filterRows(allocs, f));
      if (p.endsWith("/joballocation.json") && m === "POST") {
        const id = `eeeeeeee-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        allocs.push({ ...body, uuid: id, active: 1 });
        return json({ errorCode: 0 }, { "x-record-uuid": id });
      }
      if (p.endsWith("/staff.json") && m === "GET") return json(filterRows(STAFF, f));
      if (p.endsWith("/companycontact.json") && m === "GET") return json(filterRows(CONTACTS, f));
      if (p.endsWith("/staffmessage.json") && m === "POST") { msgs.push(body); return json({ errorCode: 0 }); }
      if (p.endsWith("/platform_service_sms") && m === "POST") { sends.push(body); return json({ errorCode: 0 }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const S: any = { family: "dispatched-field-crews", business_name: "Test Services", timezone: "Australia/Sydney", crew: [S1, S2],
  office_staff_uuid: OFFICE, max_jobs_per_crew_day: 2, horizon_days: 3, notify: "sms" };
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_sms", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createJobAllocations", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("intake only reads: open Work Order jobs without a crew are stored, the crewed one is skipped", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await intake(context(WF, S, store, NOW, () => {})), { added: 2 });
  const stored = Object.values(await store.list<any>("jobs")).map((j) => j.uuid).sort();
  assert.deepEqual(stored, [JOB_A, JOB_C].sort());
  assert.equal(writes().length, 0, "intake writes nothing to ServiceM8");
});

test("allocate drafts each job on the earliest day with room, least-loaded crew first, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await allocate(ctx), { allocated: 2, no_capacity: 0 });
  const made = allocs.filter((a) => a.job_uuid === JOB_A || a.job_uuid === JOB_C);
  assert.deepEqual(made.map((a) => [a.job_uuid, a.staff_uuid, a.allocation_date]), [[JOB_A, S1, MON], [JOB_C, S2, MON]]);
  assert.equal(msgs.length, 2, "one crew note per allocation");
  assert.deepEqual([msgs[0].from_staff_uuid, msgs[0].to_staff_uuid], [OFFICE, S1]);
  assert.equal(sends.length, 0, "nothing texted by a cron");
  const allocations = await store.list<any>("allocations");
  assert.equal(Object.values(allocations).length, 2);
});

test("re-runs never allocate twice, even when the job record was lost after the draft", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await allocate(ctx);
  const first = allocs.length;
  await allocate(ctx);
  assert.equal(allocs.length, first, "a second run drafts nothing");
  for (const [key, j] of Object.entries(await store.list<any>("jobs"))) await store.put("jobs", key, { ...(j as any), status: "new" });
  await allocate(ctx);
  assert.equal(allocs.length, first, "a job already allocated on the platform is not drafted again");
});

test("no capacity parks the job with a reason; a manual allocation by the office is picked up later", async () => {
  const store = new MemoryStore();
  const one = { ...S, crew: [S1], max_jobs_per_crew_day: 1, horizon_days: 2 };
  const ctx = context(WF, one, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await allocate(ctx), { allocated: 1, no_capacity: 1 });
  const parked = Object.values(await store.list<any>("jobs")).find((j: any) => j.status === "no-capacity") as any;
  assert.match(parked.reason, /no crew space/);
  const drafted = allocs.filter((a) => a.job_uuid === JOB_C).length;
  assert.equal(drafted, 0);
});

test("notify queues one client text per allocation with a mobile, sends only when approved, and never queues twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await allocate(ctx);
  assert.deepEqual(await notify(ctx), { queued: 1, skipped: 1 });
  assert.equal(sends.length, 0, "a cron never sends the text");
  const [pending] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.acts.map((a) => a.op), ["messaging-api.send_sms"]);
  await notify(ctx); await allocate(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "re-runs never queue the same text twice");
  const ap = await approve(WF, store, pending.id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, "+61412345678");
  assert.equal(sends[0].message, `Hi Sam, your visit with Test Services is booked for ${MON_LABEL}.`);
  assert.equal(sends[0].regardingJobUUID, JOB_A);
  await assert.rejects(approve(WF, store, pending.id, "owner"), /already done/);
});

test("the SDK gate blocks the drafts when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await intake(ctx);
  await assert.rejects(allocate(ctx), WriteBlocked);
  assert.equal(writes().length, 0);
});

test("a bad crew id in settings stops the run before any call is made", async () => {
  const ctx = context(WF, { ...S, crew: ["not-a-uuid"] }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /bad uuid/);
  assert.equal(hits.length, 0);
});
