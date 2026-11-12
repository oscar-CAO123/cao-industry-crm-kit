// Inspections workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, report, CRONS } from "../industries/real-estate/workflows/fulfilment/inspections/index.ts";
import fs from "node:fs";

const DIR = "industries/real-estate/workflows/fulfilment/inspections";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", JOB2 = "66666666-7777-4888-8999-000000000000";
const CO = "22222222-3333-4444-8555-666666666666", NOTE = "33333333-4444-4555-8666-777777777777";
const PHOTO = "44444444-5555-4666-8777-888888888888", DOC = "55555555-6666-4777-8888-999999999999";
type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let done: string | null = null;        // the allocation's completion timestamp: null until the visit is marked done
let email = "pat@example.com";         // the job's primary contact email

function fake() {
  hits = []; done = null; email = "pat@example.com";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname, q = u.searchParams.get("$filter") ?? "";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: q, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (p.endsWith("/job.json") && m === "GET") return json([
        { uuid: JOB, status: "Work Order", active: 1, job_description: "Routine inspection, 1 Test St", job_address: "1 Test St", company_uuid: CO },
        { uuid: JOB2, status: "Work Order", active: 1, job_description: "Blocked drain callout", job_address: "2 Test St", company_uuid: CO },
        { uuid: "not-a-uuid", status: "Work Order", active: 1, job_description: "inspection with a bad id" },
      ]);
      if (p.endsWith("/joballocation.json") && m === "GET") return json([{ uuid: "a1", active: 1, staff_uuid: "s1", completion_timestamp: done }]);
      if (p.endsWith("/companycontact.json")) return json(email ? [{ first: "Pat", last: "Owner", email, is_primary_contact: "1" }] : []);
      if (p.endsWith("/note.json") && m === "GET") return json([{ uuid: "n1", active: 1, note: "Kitchen tap drips <b>now</b>" }, { uuid: "n2", active: 1, note: "Bathroom exhaust fan works" }]);
      if (p.endsWith("/note.json") && m === "POST") return json({}, { "x-record-uuid": NOTE });
      if (p.endsWith("/attachment.json")) return json([{ uuid: PHOTO, active: 1, file_type: ".jpg" }, { uuid: DOC, active: 1, file_type: ".pdf" }]);
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const notePosts = () => hits.filter((h) => h.path.endsWith("/note.json") && h.method === "POST");
const sends = () => hits.filter((h) => h.path.endsWith("/platform_service_email") || h.path.endsWith("/platform_service_sms"));
const NOW = new Date("2026-11-09T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", KIT_ALLOW_WRITES: "1" });
});

test("the crons match the workflow record: every entry has a cron", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("runtime: a live operation cannot be drafted, and a draft operation cannot be queued", async () => {
  const ctx = context(WF, {}, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createNotes", summary: "x" }), /not a live operation/);
});

test("intake keeps only inspection jobs with valid ids, once each", async () => {
  const store = new MemoryStore(), ctx = context(WF, { inspection_match: "inspection" }, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(Object.keys(await store.list("inspections")), [`servicem8:${JOB}`]);
  assert.deepEqual(await intake(ctx), { added: 0 }, "a second run adds nothing");
  assert.equal(sends().length, 0);
});

test("the cron chain reads, drafts one note per visit and queues one report; nothing is sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, { inspection_match: "inspection" }, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0 }, "no draft before the visit is marked done");
  done = "2026-11-08 15:00:00";
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 1 });
  assert.equal(notePosts().length, 1);
  const note = notePosts()[0].body;
  assert.equal(note.related_object_uuid, JOB);
  assert.match(note.note, /Not sent/);
  assert.match(note.note, /Kitchen tap drips/);
  assert.deepEqual(await draft(ctx), { drafted: 0 }, "a finished visit is drafted once");
  assert.equal(notePosts().length, 1);

  assert.deepEqual(await report(ctx), { queued: 1, waiting: 0 });
  assert.deepEqual(await report(ctx), { queued: 0, waiting: 0 }, "re-runs never queue twice");
  assert.equal(sends().length, 0, "no cron sends");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.match(approvals[0].summary, /pat@example\.com/);
  assert.match(approvals[0].summary, /1 photos/);
});

test("approval sends the report once, with only the image attachments and escaped findings", async () => {
  const store = new MemoryStore(), ctx = context(WF, { inspection_match: "inspection" }, store, NOW, () => {});
  done = "2026-11-08 15:00:00";
  await intake(ctx); await draft(ctx); await report(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const out = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(out.status, "done");
  const sent = sends();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.to, "pat@example.com");
  assert.equal(sent[0].body.regardingJobUUID, JOB);
  assert.deepEqual(sent[0].body.attachments, [PHOTO], "the PDF is not attached");
  assert.match(sent[0].body.htmlBody, /Kitchen tap drips &lt;b&gt;now&lt;\/b&gt;/, "notes are escaped");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1, "sent once");
});

test("a report with no owner email waits for a person and queues nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, { inspection_match: "inspection" }, store, NOW, () => {});
  done = "2026-11-08 15:00:00";
  email = "";
  await intake(ctx); await draft(ctx);
  assert.deepEqual(await report(ctx), { queued: 0, waiting: 1 });
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
  assert.equal(sends().length, 0);
});
