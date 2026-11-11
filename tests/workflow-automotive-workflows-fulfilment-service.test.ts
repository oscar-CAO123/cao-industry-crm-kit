// Service-reminder workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { dueList, remind, replies } from "../industries/automotive/workflows/fulfilment/service/index.ts";
import { uuid } from "../industries/automotive/workflows/fulfilment/service/adapters/servicem8.ts";
import { addMonths, fill, type Due } from "../industries/automotive/workflows/fulfilment/service/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/automotive/workflows/fulfilment/service/workflow.json", "utf8")) as WorkflowRecord;
// Completed 2025-12-01: due 2026-12-01, 22 days after the run date, so it is reminded now.
const JOB_SOON = "11111111-2222-4333-8444-555555555555";
// Completed 2025-10-01: due 2026-10-01, 39 days overdue, still inside the 60 day window.
const JOB_OVERDUE = "66666666-2222-4333-8444-555555555555";
// Completed 2025-06-01: due 2026-06-01, long past the window, so it is not recorded.
const JOB_OLD = "77777777-2222-4333-8444-555555555555";
const JOB_OPEN = "88888888-2222-4333-8444-555555555555";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any; query: string };
let hits: Hit[] = [];
let inbound: { uuid: string; related_object_uuid: string; direction: string; message: string; timestamp: string }[] = [];

function fake() {
  hits = []; inbound = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname, f = u.searchParams.get("$filter") ?? "";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, query: f });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/job.json") && m === "GET") return json([
        { uuid: JOB_SOON, status: "Completed", active: 1, completion_date: "2025-12-01 12:00:00", job_address: "1 Test St", job_description: "Major service" },
        { uuid: JOB_OVERDUE, status: "Completed", active: 1, completion_date: "2025-10-01 09:00:00", job_address: "2 Test St", job_description: "Minor service" },
        { uuid: JOB_OLD, status: "Completed", active: 1, completion_date: "2025-06-01 09:00:00", job_address: "3 Test St", job_description: "Old service" },
        { uuid: JOB_OPEN, status: "Work Order", active: 1, completion_date: "", job_address: "4 Test St", job_description: "Open" },
      ]);
      if (p.endsWith("/jobcontact.json") && m === "GET") {
        const id = f.match(/job_uuid eq '([^']+)'/)?.[1];
        const rows: Record<string, any> = {
          [JOB_SOON]: { job_uuid: JOB_SOON, first: "Sam", last: "Lee", email: "sam@example.com", mobile: "0412 345 678", is_primary_contact: "1", active: 1 },
          [JOB_OVERDUE]: { job_uuid: JOB_OVERDUE, first: "Ari", last: "Park", email: "ari@example.com", mobile: "", is_primary_contact: "1", active: 1 },
        };
        return json(id && rows[id] ? [rows[id]] : []);
      }
      if (p.endsWith("/sms.json") && m === "GET") return json(inbound.filter((r) => f.includes(r.related_object_uuid)));
      if (p.endsWith("/platform_service_sms") || p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /platform_service_(email|sms)$/.test(h.path));
const S: any = { family: "fleet-account-reminders", business_name: "Test Motors", service_interval_months: 12, remind_before_days: 30,
  channel: "sms", max_per_run: 25 };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", KIT_ALLOW_WRITES: "1" });
});

test("due list records only jobs whose service falls due in the window, and reads only", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await dueList(ctx), { added: 2, updated: 0 });
  const due = await store.list<any>("due");
  assert.deepEqual(Object.keys(due).sort(), [JOB_OVERDUE, JOB_SOON].sort());
  assert.equal(due[JOB_SOON].due, "2026-12-01");
  assert.equal(due[JOB_OVERDUE].due, "2026-10-01");
  assert.equal(due[JOB_SOON].contact.phone, "+61412345678", "mobile converted to +61 form");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "no write request at all");
});

test("remind queues one approval per due job, oldest first, and never queues the same one twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await dueList(ctx);
  assert.deepEqual(await remind(ctx), { queued: 2, skipped: 0 });
  assert.equal(sends().length, 0, "queued, not sent");
  const sms = await store.get<Approval>("approvals", approvalId(WF.id, `remind:${JOB_SOON}:2026-12-01`));
  assert.equal(sms!.status, "pending");
  assert.equal(sms!.acts[0].op, "messaging-api.send_sms");
  assert.equal(sms!.acts[0].input!.body!.to, "+61412345678");
  await remind(ctx);
  assert.equal(Object.keys(await store.list("approvals")).length, 2, "re-runs never queue twice");
});

test("an approved reminder sends once, to the right number, with the job attached", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await dueList(ctx); await remind(ctx);
  const id = approvalId(WF.id, `remind:${JOB_SOON}:2026-12-01`);
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  const sms = sends().find((h) => h.path.endsWith("/platform_service_sms"))!;
  assert.equal(sms.body.to, "+61412345678");
  assert.equal(sms.body.regardingJobUUID, JOB_SOON);
  assert.match(sms.body.message, /^Hi Sam, your vehicle is due for its next service with Test Motors\./);
  await assert.rejects(approve(WF, store, id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1, "one send only");
});

test("a customer with only an email gets the email route", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S, channel: "sms" }, store, NOW, () => {});
  await dueList(ctx); await remind(ctx);
  const ap = await store.get<Approval>("approvals", approvalId(WF.id, `remind:${JOB_OVERDUE}:2026-10-01`));
  assert.equal(ap!.acts[0].op, "messaging-api.send_email");
  assert.equal(ap!.acts[0].input!.body!.to, "ari@example.com");
  assert.equal(ap!.acts[0].input!.body!.regardingJobUUID, JOB_OVERDUE);
});

test("a failed send (writes blocked on the deploy) is recorded as failed and nothing is sent", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await dueList(ctx); await remind(ctx);
  const ap = await approve(WF, store, approvalId(WF.id, `remind:${JOB_SOON}:2026-12-01`), "owner", NOW);
  assert.equal(ap.status, "failed");
  assert.equal(sends().length, 0);
});

test("replies cron records inbound texts only on jobs whose reminder was approved and sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await dueList(ctx); await remind(ctx);
  inbound = [
    { uuid: "aaaaaaaa-0000-4000-8000-000000000001", related_object_uuid: JOB_SOON, direction: "inbound", message: "Can I book Thursday?", timestamp: "2026-11-09 10:00:00" },
    { uuid: "aaaaaaaa-0000-4000-8000-000000000002", related_object_uuid: JOB_SOON, direction: "outbound", message: "our own text", timestamp: "2026-11-09 10:01:00" },
  ];
  assert.deepEqual(await replies(ctx), { found: 0 }, "no reminder approved yet, so nothing is read back");
  await approve(WF, store, approvalId(WF.id, `remind:${JOB_SOON}:2026-12-01`), "owner", NOW);
  assert.deepEqual(await replies(ctx), { found: 1 });
  assert.deepEqual(await replies(ctx), { found: 0 }, "a reply is recorded once");
  const d = await store.get<any>("due", JOB_SOON);
  assert.deepEqual(d.replies.map((r: any) => r.text), ["Can I book Thursday?"]);
  assert.equal(sends().length, 1, "replies never sends");
});

test("runtime: a live operation cannot be drafted and a read cannot be queued", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_sms", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.listJobs", summary: "x" }), /not a live operation/);
});

test("bad settings stop the run, and a malformed job id is never used in a filter", async () => {
  const ctx = context(WF, { ...S, service_interval_months: 0 }, new MemoryStore(), NOW, () => {});
  await assert.rejects(dueList(ctx), /service_interval_months must be a whole number/);
  assert.equal(uuid("11111111-2222-4333-8444-555555555555' or 'x"), undefined);
  assert.equal(uuid(JOB_SOON), JOB_SOON);
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28", "short months clamp to their last day");
});

test("remind: a job already queued, or with no usable contact, does not use up the run's limit", async () => {
  const NO_CONTACT = "55555555-2222-4333-8444-555555555555";
  const store = new MemoryStore(), ctx = context(WF, { ...S, max_per_run: 1 }, store, NOW, () => {});
  await dueList(ctx);
  // The oldest service of all, with no phone or email: it must not hold the one place in the run.
  await store.put("due", NO_CONTACT, { key: NO_CONTACT, platform: "servicem8", job_uuid: NO_CONTACT, address: "9 Test St", description: "Old service",
    completed: "2025-09-20", due: "2026-09-20", contact: {}, seen: NOW.toISOString() } satisfies Due);
  assert.deepEqual(await remind(ctx), { queued: 1, skipped: 1 });
  assert.ok(await store.get("approvals", approvalId(WF.id, `remind:${JOB_OVERDUE}:2026-10-01`)), "the oldest reachable job is queued");
  // The approver rejects that reminder. It stays on record, and the next run goes on to the next job.
  await reject(WF, store, approvalId(WF.id, `remind:${JOB_OVERDUE}:2026-10-01`), "owner", NOW);
  assert.deepEqual(await remind(ctx), { queued: 1, skipped: 1 });
  assert.ok(await store.get("approvals", approvalId(WF.id, `remind:${JOB_SOON}:2026-12-01`)), "the next job is queued");
  assert.equal(sends().length, 0, "nothing sent");
});

test("fill: a name or business containing $& or $' is inserted as typed, not read as a replacement pattern", () => {
  assert.equal(fill("Hi {first}, from {business}.", "O$&Brien", "Ace $' Motors"), "Hi O$&Brien, from Ace $' Motors.");
});
