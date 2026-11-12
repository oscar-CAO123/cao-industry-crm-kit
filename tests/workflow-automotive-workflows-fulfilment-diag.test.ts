// Diagnostic write-up workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, queue } from "../industries/automotive/workflows/fulfilment/diag/index.ts";
import fs from "node:fs";

const DIR = "industries/automotive/workflows/fulfilment/diag";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", JOB2 = "22222222-3333-4444-8555-666666666666", CO = "87654321-4321-4321-8321-210987654321";
const TECH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", TECH2 = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee", PH = "99999999-8888-4777-8666-555555555555";
const NOW = new Date("2026-11-09T00:00:00Z");
const NOTE_IDS = ["c0000000-0000-4000-8000-000000000001", "c0000000-0000-4000-8000-000000000002", "c0000000-0000-4000-8000-000000000003"];
type Hit = { method: string; path: string; body: any };

let hits: Hit[] = [];
let notes: any[] = [];
let photos: any[] = [];
let jobs: any[] = [];
let noteSeq = 0;
let withNoteId = true;      // false: the platform files the note but returns no x-record-uuid
let failNotesFor: string[] = [];  // job uuids whose note list answers 404
let failReads: string[] = [];     // note uuids whose text answers 404

const jobRow = (uuid: string) => ({ uuid, status: "Quote", active: 1, job_description: "Brakes squeal", job_address: "3 Test Rd", company_uuid: CO, date: "2026-11-08" });

function fake() {
  hits = []; noteSeq = 0; withNoteId = true; failNotesFor = []; failReads = [];
  photos = [{ uuid: PH, file_type: ".jpg", attachment_name: "front-left.jpg", related_object: "job", related_object_uuid: JOB, active: 1 }];
  notes = [{ uuid: TECH, note: "Car pulls left under braking. Left front caliper seized, pad wear 2mm, rotor scored. <b>Photos taken.</b>", related_object: "job", related_object_uuid: JOB, active: 1 }];
  jobs = [{ uuid: JOB, status: "Quote", active: 1, job_description: "Pulls left when braking", job_address: "2 Test Rd", company_uuid: CO, date: "2026-11-08" }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname, f = u.searchParams.get("$filter") ?? "";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (p.endsWith("/job.json") && m === "GET") return json(jobs);
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", is_primary_contact: "1" }]);
      if (p.endsWith("/note.json") && m === "GET") {
        const id = f.match(/related_object_uuid eq '([^']+)'/)?.[1];
        if (id && failNotesFor.includes(id)) return new Response("not found", { status: 404 });
        return json(notes.filter((n) => !id || n.related_object_uuid === id));
      }
      if (p.endsWith("/note.json") && m === "POST") {
        const uuid = NOTE_IDS[noteSeq++];
        notes.push({ uuid, note: body.note, related_object: body.related_object, related_object_uuid: body.related_object_uuid, active: 1 });
        return json({ errorCode: 0 }, withNoteId ? { "x-record-uuid": uuid } : {});
      }
      if (/\/dbonote\/[^/]+\.json$/.test(p)) {
        const id = p.split("/").pop()!.replace(".json", "");
        if (failReads.includes(id)) return new Response("not found", { status: 404 });
        return json(notes.find((n) => n.uuid === id) ?? {});
      }
      if (p.endsWith("/attachment.json")) return json(photos);
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/platform_service_email"));
const filedNotes = () => hits.filter((h) => h.path.endsWith("/note.json") && h.method === "POST");
const S: any = { business_name: "Test Auto", intake_status: "Quote", min_note_chars: 40, email_subject: "Your write-up" };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a send and a cron cannot queue a note", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createNotes", summary: "x" }), /not a live operation/);
});

test("crons file a DRAFT note and queue nothing until the shop finishes the write-up", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_notes: 0 });
  const filed = hits.find((h) => h.path.endsWith("/note.json") && h.method === "POST")!.body;
  assert.equal(filed.related_object, "job");
  assert.equal(filed.related_object_uuid, JOB);
  assert.match(filed.note, /^DRAFT WRITE-UP/);
  assert.match(filed.note, /Photos on the job: 1 \(front-left\.jpg\)/);
  assert.equal(sends().length, 0, "nothing sent");
  assert.deepEqual(await queue(ctx), { queued: 0, waiting: 1 }, "a DRAFT note is not queued");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0, "nothing queued yet");
  // Re-runs never file a second note.
  await intake(ctx); await draft(ctx);
  assert.equal(hits.filter((h) => h.path.endsWith("/note.json") && h.method === "POST").length, 1);
});

test("a job with too little in its notes is parked, not written up", async () => {
  notes = [{ uuid: TECH, note: "Noisy", related_object: "job", related_object_uuid: JOB, active: 1 }];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_notes: 1 });
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/note.json")).length, 0);
});

test("once the shop removes the marker, the email is queued; approval sends it once, escaped", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  // The shop rewrites the note in plain words and removes the DRAFT line.
  const mine = notes.find((n) => n.uuid === NOTE_IDS[0])!;
  mine.note = "Front left brake caliper has seized, so the car pulls left.\nBrake pads are worn to 2mm and the rotor is scored.";
  assert.deepEqual(await queue(ctx), { queued: 1, waiting: 0 });
  assert.deepEqual(await queue(ctx), { queued: 0, waiting: 0 }, "a second queue run does not queue again");
  assert.equal(sends().length, 0, "queued, not sent");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].acts.map((a) => a.op), ["messaging-api.send_email"]);
  // The approver sees the whole email as it will go: recipient, subject and the customer text.
  assert.match(pending[0].summary, /^Email to sam@example\.com/);
  assert.match(pending[0].summary, /Subject: Your write-up/);
  assert.match(pending[0].summary, /Front left brake caliper has seized/);
  assert.match(pending[0].summary, /Brake pads are worn to 2mm/);
  await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(sends().length, 1);
  const email = sends()[0].body;
  assert.equal(email.to, "sam@example.com");
  assert.equal(email.regardingJobUUID, JOB);
  assert.match(email.htmlBody, /Front left brake caliper has seized/);
  assert.doesNotMatch(email.htmlBody, /<b>/, "customer text is escaped");
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("a note filed with no id back is marked check, is never filed again, and is never queued", async () => {
  withNoteId = false;
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_notes: 0 }, "no throw: the note is filed and a person checks it");
  assert.equal((await store.get<any>("diagnoses", `servicem8:${JOB}`))!.status, "check");
  await intake(ctx); await draft(ctx);
  assert.equal(filedNotes().length, 1, "filed once, never again");
  assert.deepEqual(await queue(ctx), { queued: 0, waiting: 0 });
  assert.equal(sends().length, 0);
});

test("a job whose notes cannot be read is left as it was, and the other jobs still get their write-up", async () => {
  jobs = [jobRow(JOB), jobRow(JOB2)];
  failNotesFor = [JOB];
  notes.push({ uuid: TECH2, note: "Brakes squeal from cold. Pads 4mm front, rotors fine, customer wants a quote.", related_object: "job", related_object_uuid: JOB2, active: 1 });
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_notes: 0 });
  assert.equal((await store.get<any>("diagnoses", `servicem8:${JOB}`))!.status, "new", "left as it was, to retry");
  assert.equal((await store.get<any>("diagnoses", `servicem8:${JOB2}`))!.status, "drafted");
});

test("the queue run skips a note it cannot read and still queues the others", async () => {
  jobs = [jobRow(JOB), jobRow(JOB2)];
  notes.push({ uuid: TECH2, note: "Brakes squeal from cold. Pads 4mm front, rotors fine, customer wants a quote.", related_object: "job", related_object_uuid: JOB2, active: 1 });
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 2, needs_notes: 0 });
  notes.find((n) => n.uuid === NOTE_IDS[1])!.note = "Front pads are 4mm and the rotors are fine. Quote for pads and rotors to follow.";
  failReads = [NOTE_IDS[0]];
  assert.deepEqual(await queue(ctx), { queued: 1, waiting: 0 });
  assert.equal((await store.get<any>("diagnoses", `servicem8:${JOB2}`))!.status, "queued");
  assert.equal((await store.get<any>("diagnoses", `servicem8:${JOB}`))!.status, "drafted", "still waiting, nothing lost");
});
