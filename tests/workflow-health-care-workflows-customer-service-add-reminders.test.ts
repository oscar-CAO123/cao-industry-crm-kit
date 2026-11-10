// Appointment reminders and waitlist workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { describe } from "../core/sdk/call.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { reminders, cancellations, waitlistBook, firstName, CRONS } from "../industries/health-care/workflows/customer-service/add-reminders/index.ts";
import fs from "node:fs";

const DIR = "industries/health-care/workflows/customer-service/add-reminders";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const S: any = JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8"));
const BOOK = "individual-appointment.createindividualappointment";
const NOW = new Date("2026-11-09T00:00:00Z");
const H = 36e5, D = 864e5;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let APPTS: any[] = [];

function appts() {
  return [
    { id: "101", starts_at: at(24 * H), patient_id: "11", patient_name: "Jane Smith", appointment_type_id: "5", practitioner_id: "900", business_id: "1",
      cancelled_at: null, archived_at: null, deleted_at: null, did_not_arrive: false, sms_reminder_sent: false, email_reminder_sent: false },   // needs a reminder
    { id: "102", starts_at: at(30 * H), patient_id: "12", patient_name: "Ali Chen", practitioner_id: "900", business_id: "1",
      cancelled_at: null, did_not_arrive: false, sms_reminder_sent: true, email_reminder_sent: false },                                       // already reminded
    { id: "103", starts_at: at(36 * H), patient_id: "13", patient_name: "<img src=x onerror=alert(1)> Bob", appointment_type_id: "5", practitioner_id: "900", business_id: "1",
      cancelled_at: at(-1 * H), archived_at: null, deleted_at: null, did_not_arrive: false, sms_reminder_sent: false, email_reminder_sent: false }, // cancelled, slot is open
    { id: "104", starts_at: at(5 * D), patient_id: "14", patient_name: "Sam Lee", practitioner_id: "900", business_id: "1",
      cancelled_at: null, did_not_arrive: false, sms_reminder_sent: false, email_reminder_sent: false },                                     // outside the reminder window
    { id: "105", starts_at: at(4 * D), patient_id: "15", patient_name: "Ruth Wu", practitioner_id: "901", business_id: "1",
      cancelled_at: at(-2 * H), archived_at: null, deleted_at: null, did_not_arrive: false, sms_reminder_sent: true, email_reminder_sent: false }, // cancelled, slot is open
    { id: "106", starts_at: at(20 * H), patient_id: "16", patient_name: "Lee Park", practitioner_id: "900", business_id: "1",
      cancelled_at: null, did_not_arrive: true, sms_reminder_sent: false, email_reminder_sent: false },                                      // did not arrive
  ];
}

/** Read the start bound from the single q[] filter the adapter sends. */
function startFrom(q: string): number {
  const m = /^starts_at:>=(.+)$/.exec(q);
  return m ? Date.parse(m[1]) : 0;
}

function fake() {
  hits = []; APPTS = appts();
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.search, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v1/individual_appointments" && m === "GET") {
        const from = startFrom(u.searchParams.get("q[]") ?? "");
        const rows = APPTS.filter((a) => Date.parse(a.starts_at) >= from);
        return json({ individual_appointments: rows, total_entries: rows.length });
      }
      if (p === "/v1/individual_appointments" && m === "POST") return json({ id: "777", starts_at: body?.starts_at }, 201);
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake();
  Object.assign(process.env, { CLINIKO_API_KEY: "k", CLINIKO_USER_AGENT: "kit-test", KIT_ALLOW_WRITES: "1" });
});

test("definitions: every operation is mapped, draft ops are reads, the one live op is the booking write", () => {
  for (const op of WF.draft_ops.cliniko) assert.equal(describe("cliniko", op).kind, "read", op);
  for (const op of WF.live_ops.cliniko) assert.equal(describe("cliniko", op).kind, "write", op);
  assert.deepEqual(WF.live_ops.cliniko, [BOOK]);
  assert.deepEqual(Object.keys(CRONS).sort(), ["cancellations", "reminders", "waitlist-book"]);
});

test("runtime: a cron cannot run the booking as a draft and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "cliniko", op: BOOK, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "cliniko", op: "individual-appointment.listindividualappointments", summary: "x" }), /not a live operation/);
});

test("reminders drafts only the gaps Cliniko left, once, and never writes to Cliniko", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await reminders(ctx), { drafted: 1 });
  const drafts = await store.list<any>("drafts");
  assert.deepEqual(Object.keys(drafts), ["reminder:101"]);
  assert.match(drafts["reminder:101"].text, /^Hi Jane, a reminder of your appointment on /);
  assert.equal(writes().length, 0);
  assert.deepEqual(await reminders(ctx), { drafted: 0 });   // a second run drafts nothing new
  assert.equal(writes().length, 0);
});

test("a patient name that is not a plain name never reaches a draft", () => {
  assert.equal(firstName("<img src=x onerror=alert(1)> Bob"), "there");
  assert.equal(firstName("Jane Smith"), "Jane");
  assert.equal(firstName(undefined), "there");
});

test("cancellations opens each freed slot once, drafts an offer, and never writes", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await cancellations(ctx), { opened: 2 });
  assert.deepEqual(Object.keys(await store.list("openings")).sort(), ["103", "105"]);
  assert.deepEqual(Object.keys(await store.list("drafts")).sort(), ["offer:103", "offer:105"]);
  assert.equal((await store.get<any>("openings", "103"))!.status, "open");
  assert.deepEqual(await cancellations(ctx), { opened: 0 });
  assert.equal(writes().length, 0);
});

test("waitlist-book queues a booking only after a person marks the opening accepted, and never queues twice", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await cancellations(ctx);
  assert.deepEqual(await waitlistBook(ctx), { queued: 0, booked: 0 });   // nobody has accepted yet
  await store.put("openings", "103", { ...(await store.get<any>("openings", "103")), status: "accepted", accepted_by: "5551" });

  assert.deepEqual(await waitlistBook(ctx), { queued: 1, booked: 0 });
  const id = approvalId(WF.id, "book:103");
  const queued = await store.get<Approval>("approvals", id);
  assert.equal(queued?.status, "pending");
  assert.equal(queued?.acts[0].op, BOOK);
  assert.equal(writes().length, 0, "queuing never reaches Cliniko");

  assert.deepEqual(await waitlistBook(ctx), { queued: 0, booked: 0 });   // a second run does not queue it again
  assert.equal(Object.keys(await store.list("approvals")).length, 1);

  const done = await approve(WF, store, id, "Owner", NOW);
  assert.equal(done.status, "done");
  const post = writes();
  assert.equal(post.length, 1);
  assert.equal(post[0].path, "/v1/individual_appointments");
  assert.equal(post[0].method, "POST");
  assert.equal(post[0].body.patient_id, "5551");
  assert.equal(post[0].body.practitioner_id, "900");

  assert.deepEqual(await waitlistBook(ctx), { queued: 0, booked: 1 });
  const opening = await store.get<any>("openings", "103");
  assert.equal(opening.status, "booked");
  assert.equal(opening.booked_ref, "777");
  assert.equal(writes().length, 1, "a booked opening is never booked again");
});

test("waitlist-book leaves an opening alone when its slot was taken before queuing", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await cancellations(ctx);
  await store.put("openings", "103", { ...(await store.get<any>("openings", "103")), status: "accepted", accepted_by: "5551" });
  APPTS.push({ id: "200", starts_at: at(36 * H), patient_id: "20", practitioner_id: "900", business_id: "1", cancelled_at: null, did_not_arrive: false });
  assert.deepEqual(await waitlistBook(ctx), { queued: 0, booked: 0 });
  assert.equal((await store.get<any>("openings", "103"))!.status, "taken");
});

test("waitlist-book refuses a patient id that is not plain digits", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await cancellations(ctx);
  await store.put("openings", "103", { ...(await store.get<any>("openings", "103")), status: "accepted", accepted_by: "5551; DROP" });
  assert.deepEqual(await waitlistBook(ctx), { queued: 0, booked: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("a booking with writes blocked fails closed and is not retried", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  await cancellations(ctx);
  await store.put("openings", "103", { ...(await store.get<any>("openings", "103")), status: "accepted", accepted_by: "5551" });
  await waitlistBook(ctx);
  delete process.env.KIT_ALLOW_WRITES;
  const ap = await approve(WF, store, approvalId(WF.id, "book:103"), "Owner", NOW);
  assert.equal(ap.status, "failed");
  assert.match(ap.error ?? "", /write blocked/);
  assert.equal(writes().length, 0);
  assert.deepEqual(await waitlistBook(ctx), { queued: 0, booked: 0 });   // the cron does not queue a second time
});
