// Care plan from intake: tests. Every request goes to a fake network: no test reaches a real Cliniko account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, forms } from "../industries/health-care/workflows/fulfilment/careplan/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/health-care/workflows/fulfilment/careplan/workflow.json", "utf8")) as WorkflowRecord;
type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let formDone = false;

function fake() {
  hits = []; formDone = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.search, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p.endsWith("/patients") && m === "GET") return json({ patients: [
        { id: "101", created_at: "2026-11-08T01:00:00Z" },
        { id: "102", created_at: "2026-11-08T02:00:00Z" },
        { id: "../x", created_at: "2026-11-08T03:00:00Z" }], total_entries: 3 });
      if (p.endsWith("/patients/101/referral_source")) return json({ referral_source_type: { name: "GP referral" } });
      if (p.endsWith("/patients/102/referral_source")) return json({ errors: "not found" }, 404);
      if (p.endsWith("/treatment_notes") && m === "POST") return json({ id: "5001" }, 201);
      if (p.endsWith("/patient_forms") && m === "POST") return json({ id: "7001", completed: false }, 201);
      if (p.endsWith("/patient_forms/7001") && m === "GET") return json({ id: "7001", completed: formDone });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const S: any = { business_name: "Test Clinic", care_plan_template_id: "900", intake_form_template_id: "800", lookback_days: 14 };
const NOW = new Date("2026-11-08T04:00:00Z");
const posts = (suffix: string) => hits.filter((h) => h.method === "POST" && h.path.endsWith(suffix));

beforeEach(() => {
  fake();
  Object.assign(process.env, { CLINIKO_API_KEY: "test-key", CLINIKO_USER_AGENT: "Test Clinic (test@example.com)", CLINIKO_SHARD: "au1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run the live form create as a draft, nor queue the draft note", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "cliniko", op: "patient-form.createpatientform", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "cliniko", op: "treatment-note.createtreatmentnote", summary: "x" }), /not a live operation/);
});

test("the SDK gate blocks the draft note when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await assert.rejects(draft(context(WF, S, store, NOW, () => {})), WriteBlocked);
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0);
});

test("a placeholder template id stops the draft cron before any write", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  const bad = { ...S, care_plan_template_id: "REPLACE_WITH_CLINIKO_TREATMENT_NOTE_TEMPLATE_ID" };
  await assert.rejects(draft(context(WF, bad, store, NOW, () => {})), /bad id/);
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0);
});

test("intake reads new patients and their referral sources, skips a bad id, and writes nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await intake(context(WF, S, store, NOW, () => {})), { added: 2 });
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0);
  const list = hits.find((h) => h.path.endsWith("/patients"))!;
  assert.deepEqual(new URLSearchParams(list.query).getAll("q[]"), ["created_at:>=2026-10-25T04:00:00Z"], "lookback window is 14 days");
  assert.deepEqual(Object.keys(await store.list("enquiries")).sort(), ["cliniko:101", "cliniko:102"]);
  assert.equal((await store.get<any>("enquiries", "cliniko:101")).referral, "GP referral");
  assert.equal((await store.get<any>("enquiries", "cliniko:102")).referral, null, "a 404 referral is no referral");
});

test("draft: a care plan note is drafted and the intake form is queued, never sent; re-runs repeat neither", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await draft(context(WF, S, store, NOW, () => {})), { drafted: 2 });
  const notes = posts("/treatment_notes").map((h) => h.body);
  assert.deepEqual(notes.map((n) => [n.patient_id, n.treatment_note_template_id, n.draft]), [["101", "900", true], ["102", "900", true]]);
  assert.equal(posts("/patient_forms").length, 0, "no form created by a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((a) => a.status === "pending" && a.acts[0].op === "patient-form.createpatientform"));
  await intake(context(WF, S, store, NOW, () => {}));
  await draft(context(WF, S, store, NOW, () => {}));
  assert.equal(posts("/treatment_notes").length, 2, "no second note");
  assert.equal(Object.keys(await store.list("approvals")).length, 2, "no form queued twice");
});

test("an approved intake form is created once, then recorded once it is completed", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await draft(context(WF, S, store, NOW, () => {}));
  const id = approvalId(WF.id, "form:101");
  const done = await approve(WF, store, id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(done.results?.[0]?.ref?.id, "7001");
  const created = posts("/patient_forms");
  assert.equal(created.length, 1);
  assert.deepEqual([created[0].body.patient_form_template_id, created[0].body.patient_id, created[0].body.email_to_patient_on_completion], ["800", "101", false]);
  await assert.rejects(approve(WF, store, id, "owner", NOW), /already done/);
  assert.deepEqual(await forms(context(WF, S, store, NOW, () => {})), { completed: 0 }, "not completed yet");
  assert.equal(await store.get("forms", "form:7001"), undefined);
  formDone = true;
  assert.deepEqual(await forms(context(WF, S, store, NOW, () => {})), { completed: 1 });
  assert.deepEqual(await forms(context(WF, S, store, NOW, () => {})), { completed: 0 }, "a completed form is recorded once");
});
