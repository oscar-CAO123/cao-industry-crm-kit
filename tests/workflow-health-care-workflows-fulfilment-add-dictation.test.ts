// Session notes from dictation: tests. Every request goes to a fake network: no test reaches a real Cliniko account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe as describeOp } from "../core/sdk/call.ts";
import { draft, check, sign, CRONS } from "../industries/health-care/workflows/fulfilment/add-dictation/index.ts";
import fs from "node:fs";

const DIR = "industries/health-care/workflows/fulfilment/add-dictation";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Clinic", default_template_id: "7" };
const NOTE = "555";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let noteDraft = true;
let failCreate = false;

function fake() {
  hits = []; noteDraft = true; failCreate = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v1/treatment_notes" && m === "POST") return failCreate ? json({ errors: ["refused"] }, 422) : json({ id: NOTE, draft: true }, 201);
      if (p === `/v1/treatment_notes/${NOTE}` && m === "GET") return json({ id: NOTE, draft: noteDraft });
      if (p === `/v1/treatment_notes/${NOTE}` && m === "PATCH") { noteDraft = false; return json({ id: NOTE, draft: false }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const writes = (method: string) => hits.filter((h) => h.method === method);
const session = (over: Record<string, unknown> = {}) => ({
  id: "s1", title: "Review visit", patient_id: "101", attendee_id: "202",
  sections: [{ name: "Subjective", description: "", questions: [{ name: "Presenting complaint", answer: "Knee pain <script>x</script>\n\nWorse on stairs" }] }],
  status: "transcript-ready", created: NOW.toISOString(), ...over,
});

beforeEach(() => {
  fake();
  Object.assign(process.env, { CLINIKO_API_KEY: "test-key", CLINIKO_USER_AGENT: "kit-test", KIT_ALLOW_WRITES: "1" });
});

test("the workflow's operations are all mapped, and no live operation is also a draft one", () => {
  for (const [platform, ops] of Object.entries(WF.draft_ops)) for (const op of ops) assert.doesNotThrow(() => describeOp(platform, op), op);
  for (const [platform, ops] of Object.entries(WF.live_ops)) for (const op of ops) assert.doesNotThrow(() => describeOp(platform, op), op);
  const draftOps = Object.values(WF.draft_ops).flat(), liveOps = Object.values(WF.live_ops).flat();
  assert.deepEqual(draftOps.filter((o) => liveOps.includes(o)), []);
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("runtime: a lock cannot run as a draft, and a draft write cannot be queued as live", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "cliniko", op: "treatment-note.updatetreatmentnote", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "cliniko", op: "treatment-note.createtreatmentnote", summary: "x" }), /not a live operation/);
});

test("draft cron writes a draft note with escaped answers, and never locks it", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session());
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 1, needs_check: 0 });
  const [create] = writes("POST");
  assert.equal(create.path, "/v1/treatment_notes");
  assert.equal(create.body.draft, true);
  assert.equal(create.body.patient_id, "101");
  assert.equal(create.body.treatment_note_template_id, "7");
  const answer = create.body.content.sections[0].questions[0].answer;
  assert.ok(answer.includes("&lt;script&gt;x&lt;/script&gt;"), "answer is escaped");
  assert.ok(answer.includes("<p>Worse on stairs</p>"), "paragraphs become p tags");
  assert.equal(writes("PATCH").length, 0, "no lock from a cron");
  const s = await store.get<any>("sessions", "s1");
  assert.equal(s.status, "drafted");
  assert.equal(s.note_id, NOTE);
});

test("draft cron never creates a second note for the same session", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session());
  await draft(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 0 });
  assert.equal(writes("POST").length, 1);
});

test("a session with a bad id is parked for a person, with no note created and no patient detail in the reason", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session({ patient_id: "abc" }));
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 1 });
  assert.equal(writes("POST").length, 0, "the bad id never reaches the network");
  const s = await store.get<any>("sessions", "s1");
  assert.equal(s.status, "needs-check");
  assert.ok(!String(s.reason).includes("Knee"), "reason carries no patient content");
});

test("a platform refusal is parked for a person, and nothing is retried on its own", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session());
  failCreate = true;
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 1 });
  failCreate = false;
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 0 });
  assert.equal(writes("POST").length, 1, "the refused write is not repeated");
});

test("a run that stopped mid-write is flagged, and no second note is made", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session({ status: "drafting" }));
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 1 });
  assert.equal(writes("POST").length, 0);
  assert.equal((await store.get<any>("sessions", "s1")).status, "needs-check");
});

test("sign cron queues the lock; nothing locks until a person approves, and a second run queues nothing new", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session({ status: "reviewed", note_id: NOTE }));
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await sign(ctx), { queued: 1 });
  assert.deepEqual(await sign(context(WF, SETTINGS, store, NOW, () => {})), { queued: 0 }, "status moved on, so no second queue");
  assert.equal(writes("PATCH").length, 0, "no lock before approval");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => [a.op, (a.input as any).body]), [["treatment-note.updatetreatmentnote", { draft: false }]]);
  assert.equal((await store.get<any>("sessions", "s1")).status, "sign-queued");
});

test("an approved lock runs once, and check then marks the session signed", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session({ status: "reviewed", note_id: NOTE }));
  await sign(context(WF, SETTINGS, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  assert.equal(writes("PATCH").length, 1);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.deepEqual(await check(context(WF, SETTINGS, store, NOW, () => {})), { signed: 1, needs_check: 0 });
  assert.equal((await store.get<any>("sessions", "s1")).status, "signed");
  assert.equal(writes("PATCH").length, 1, "check never locks");
});

test("a rejected lock is flagged for a person, not queued again", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session({ status: "reviewed", note_id: NOTE }));
  await sign(context(WF, SETTINGS, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await reject(WF, store, ap.id, "owner", NOW);
  assert.deepEqual(await check(context(WF, SETTINGS, store, NOW, () => {})), { signed: 0, needs_check: 1 });
  assert.equal((await store.get<any>("sessions", "s1")).status, "needs-check");
  assert.deepEqual(await sign(context(WF, SETTINGS, store, NOW, () => {})), { queued: 0 });
});

test("check reads a note that was locked by hand in Cliniko and marks it signed, without writing", async () => {
  const store = new MemoryStore();
  await store.put("sessions", "s1", session({ status: "drafted", note_id: NOTE }));
  noteDraft = false;
  assert.deepEqual(await check(context(WF, SETTINGS, store, NOW, () => {})), { signed: 1, needs_check: 0 });
  assert.equal(writes("PATCH").length, 0);
  assert.equal(writes("POST").length, 0);
  assert.equal((await store.get<any>("sessions", "s1")).status, "signed");
});
