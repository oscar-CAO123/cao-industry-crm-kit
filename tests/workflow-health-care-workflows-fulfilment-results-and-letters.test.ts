// Results and letters to GPs: tests. Every request goes to a fake network: no test reaches a real Cliniko account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe as describeOp } from "../core/sdk/call.ts";
import { draft, recall, CRONS } from "../industries/health-care/workflows/fulfilment/results-and-letters/index.ts";
import fs from "node:fs";

const DIR = "industries/health-care/workflows/fulfilment/results-and-letters";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Clinic", default_template_id: "7", result_review_recall_type_id: "9", review_after_days: 7 };
const NOTE = "555";
const RECALL = "777";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let failCreate = false;

function fake() {
  hits = []; failCreate = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v1/treatment_notes" && m === "POST") return failCreate ? json({ errors: ["refused"] }, 422) : json({ id: NOTE, draft: true }, 201);
      if (p === "/v1/recalls" && m === "POST") return json({ id: RECALL }, 201);
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const writes = (method: string, path?: string) => hits.filter((h) => h.method === method && (!path || h.path === path));
const result = (over: Record<string, unknown> = {}) => ({
  id: "r1", patient_id: "101", title: "Pathology result", filed: "2026-11-06",
  letter: "Bloods are within the reference range.\n\nNo change to medication.",
  status: "letter-ready", created: NOW.toISOString(), ...over,
});

beforeEach(() => {
  fake();
  Object.assign(process.env, { CLINIKO_API_KEY: "test-key", CLINIKO_USER_AGENT: "kit-test", KIT_ALLOW_WRITES: "1" });
});

test("the workflow's operations are all mapped, no live operation is also a draft one, and the crons match", () => {
  for (const [platform, ops] of Object.entries(WF.draft_ops)) for (const op of ops) assert.doesNotThrow(() => describeOp(platform, op), op);
  for (const [platform, ops] of Object.entries(WF.live_ops)) for (const op of ops) assert.doesNotThrow(() => describeOp(platform, op), op);
  const draftOps = Object.values(WF.draft_ops).flat(), liveOps = Object.values(WF.live_ops).flat();
  assert.deepEqual(draftOps.filter((o) => liveOps.includes(o)), []);
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("runtime: a recall cannot run as a draft, and a note write cannot be queued as live", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "cliniko", op: "recall.createrecall", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "cliniko", op: "treatment-note.createtreatmentnote", summary: "x" }), /not a live operation/);
});

test("draft cron writes a draft GP letter with escaped text, and never finalises or recalls", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result({ letter: "Result <b>normal</b>\n\nNo change" }));
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 1, needs_check: 0 });
  const [create] = writes("POST", "/v1/treatment_notes");
  assert.equal(create.body.draft, true);
  assert.equal(create.body.patient_id, "101");
  assert.equal(create.body.treatment_note_template_id, "7");
  const answer = create.body.content.sections[0].questions[0].answer;
  assert.ok(answer.includes("Result &lt;b&gt;normal&lt;/b&gt;"), "letter text is escaped");
  assert.ok(answer.includes("<p>No change</p>"), "paragraphs become p tags");
  assert.equal(writes("PATCH").length, 0, "no finalise from a cron");
  assert.equal(writes("POST", "/v1/recalls").length, 0, "no recall from the draft cron");
  const r = await store.get<any>("results", "r1");
  assert.equal(r.status, "drafted");
  assert.equal(r.note_id, NOTE);
});

test("draft cron never creates a second note for the same result", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result());
  await draft(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 0 });
  assert.equal(writes("POST", "/v1/treatment_notes").length, 1);
});

test("a result with a bad patient id is parked for a person, with no note made and no letter text in the reason", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result({ patient_id: "abc" }));
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 1 });
  assert.equal(writes("POST").length, 0, "the bad id never reaches the network");
  const r = await store.get<any>("results", "r1");
  assert.equal(r.status, "needs-check");
  assert.ok(!String(r.reason).includes("Bloods"), "reason carries no patient content");
});

test("a platform refusal is parked for a person, and the refused write is not repeated", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result());
  failCreate = true;
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 1 });
  failCreate = false;
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 0 });
  assert.equal(writes("POST", "/v1/treatment_notes").length, 1, "the refused write is not repeated");
});

test("a run that stopped mid-write is flagged, and no second note is made", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result({ status: "drafting" }));
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 0, needs_check: 1 });
  assert.equal(writes("POST").length, 0);
  assert.equal((await store.get<any>("results", "r1")).status, "needs-check");
});

test("recall cron queues a results-review recall; nothing is created until a person approves it, and a second run queues nothing new", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result({ status: "drafted", note_id: NOTE }));
  assert.deepEqual(await recall(context(WF, SETTINGS, store, NOW, () => {})), { queued: 1, needs_check: 0 });
  assert.deepEqual(await recall(context(WF, SETTINGS, store, NOW, () => {})), { queued: 0, needs_check: 0 }, "status moved on, so no second queue");
  assert.equal(writes("POST", "/v1/recalls").length, 0, "no recall before approval");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].status, "pending");
  const [act] = aps[0].acts;
  assert.equal(act.op, "recall.createrecall");
  assert.deepEqual((act.input as any).body, { patient_id: "101", recall_type_id: "9", recall_at: "2026-11-13T00:00:00.000Z", notes: "Results review" });
  assert.equal((await store.get<any>("results", "r1")).status, "recall-queued");
});

test("an approved recall runs once, its id is kept on the approval, and the result is marked recall-set", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result({ status: "drafted", note_id: NOTE }));
  await recall(context(WF, SETTINGS, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(writes("POST", "/v1/recalls").length, 1);
  assert.equal(done.results?.[0].ref?.id, RECALL);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  await recall(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal((await store.get<any>("results", "r1")).status, "recall-set");
  assert.equal(writes("POST", "/v1/recalls").length, 1, "the recall is never created twice");
});

test("a rejected recall is flagged for a person, and is not queued again", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result({ status: "drafted", note_id: NOTE }));
  await recall(context(WF, SETTINGS, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await reject(WF, store, ap.id, "owner", NOW);
  assert.deepEqual(await recall(context(WF, SETTINGS, store, NOW, () => {})), { queued: 0, needs_check: 1 });
  assert.equal((await store.get<any>("results", "r1")).status, "needs-check");
  assert.deepEqual(await recall(context(WF, SETTINGS, store, NOW, () => {})), { queued: 0, needs_check: 0 });
  assert.equal(writes("POST", "/v1/recalls").length, 0);
});

test("with no recall type set, the recall cron queues nothing and reads nothing from the patient", async () => {
  const store = new MemoryStore();
  await store.put("results", "r1", result({ status: "drafted", note_id: NOTE }));
  const { result_review_recall_type_id: _drop, ...rest } = SETTINGS;
  assert.deepEqual(await recall(context(WF, rest, store, NOW, () => {})), { queued: 0, needs_check: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  assert.equal(hits.length, 0);
});
