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
const JOB = "11111111-2222-4333-8444-555555555555", CO = "87654321-4321-4321-8321-210987654321";
const TECH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", PH = "99999999-8888-4777-8666-555555555555";
const NOW = new Date("2026-11-09T00:00:00Z");
const NOTE_IDS = ["c0000000-0000-4000-8000-000000000001", "c0000000-0000-4000-8000-000000000002", "c0000000-0000-4000-8000-000000000003"];
type Hit = { method: string; path: string; body: any };

let hits: Hit[] = [];
let notes: any[] = [];
let photos: any[] = [];
let noteSeq = 0;

function fake() {
  hits = []; noteSeq = 0; photos = [{ uuid: PH, file_type: ".jpg", attachment_name: "front-left.jpg", related_object: "job", related_object_uuid: JOB, active: 1 }];
  notes = [{ uuid: TECH, note: "Car pulls left under braking. Left front caliper seized, pad wear 2mm, rotor scored. <b>Photos taken.</b>", related_object: "job", related_object_uuid: JOB, active: 1 }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (p.endsWith("/job.json") && m === "GET") return json([{ uuid: JOB, status: "Quote", active: 1, job_description: "Pulls left when braking", job_address: "2 Test Rd", company_uuid: CO, date: "2026-11-08" }]);
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", is_primary_contact: "1" }]);
      if (p.endsWith("/note.json") && m === "GET") return json(notes);
      if (p.endsWith("/note.json") && m === "POST") {
        const uuid = NOTE_IDS[noteSeq++];
        notes.push({ uuid, note: body.note, related_object: body.related_object, related_object_uuid: body.related_object_uuid, active: 1 });
        return json({ errorCode: 0 }, { "x-record-uuid": uuid });
      }
      if (/\/dbonote\/[^/]+\.json$/.test(p)) { const id = p.split("/").pop()!.replace(".json", ""); return json(notes.find((n) => n.uuid === id) ?? {}); }
      if (p.endsWith("/attachment.json")) return json(photos);
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/platform_service_email"));
const S: any = { business_name: "Test Auto", intake_status: "Quote", min_note_chars: 40, email_subject: "Your write-up" };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", KIT_ALLOW_WRITES: "1" });
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
  await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(sends().length, 1);
  const email = sends()[0].body;
  assert.equal(email.to, "sam@example.com");
  assert.equal(email.regardingJobUUID, JOB);
  assert.match(email.htmlBody, /Front left brake caliper has seized/);
  assert.doesNotMatch(email.htmlBody, /<b>/, "customer text is escaped");
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});
