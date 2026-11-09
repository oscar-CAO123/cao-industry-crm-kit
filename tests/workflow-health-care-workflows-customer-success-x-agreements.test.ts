// Service agreements workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, chase, CRONS } from "../industries/health-care/workflows/customer-success/x-agreements/index.ts";
import fs from "node:fs";

const DIR = "industries/health-care/workflows/customer-success/x-agreements";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Physio", cliniko: { agreement_template_id: "300" }, expire_after_days: 21 };
const NOW = new Date("2026-11-09T00:00:00Z");
const LATER = new Date(NOW.getTime() + 22 * 864e5);

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let forms: Record<string, any> = {};
let nextForm = 9001;
let failGet = false;

function fake() {
  hits = []; forms = {}; nextForm = 9001;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v1/patient_cases/active") return json({ patient_cases: [
        { id: 5001, patient_id: 7001, closed: false }, { id: 5002, patient_id: 7002, closed: false },
        { id: 5003, patient_id: "../evil", closed: false }, { id: 5004, patient_id: 7004, closed: true }] });
      if (p === "/v1/patient_forms" && m === "POST") {
        const fid = String(nextForm++);
        forms[fid] = { id: fid, patient_id: String(body.patient_id), patient_form_template_id: String(body.patient_form_template_id), completed: false, expired: false, signatures: [] };
        return json(forms[fid], 201);
      }
      const fm = p.match(/^\/v1\/patient_forms\/(\d+)$/);
      if (fm && m === "GET") { if (failGet) return json({}, 500); return forms[fm[1]] ? json(forms[fm[1]]) : json({}, 404); }
      if (fm && m === "PATCH") { Object.assign(forms[fm[1]], body); return json(forms[fm[1]]); }
      const sm = p.match(/^\/v1\/patient_forms\/(\d+)\/signatures\/(\d+)$/);
      if (sm && m === "GET") return json({ id: Number(sm[2]) });
      return json({ error: "not faked: " + p }, 404);
    }) as any,
  });
}

const writes = () => hits.filter((h) => h.method !== "GET");
const approvalsOp = async (store: MemoryStore, op: string) => Object.values(await store.list<Approval>("approvals")).filter((a) => a.acts[0].op === op);
/** A person approves every queued form creation; each one creates its form in the fake network. */
async function approveCreations(store: MemoryStore, at: Date) {
  for (const ap of await approvalsOp(store, "patient-form.createpatientform")) await approve(WF, store, ap.id, "owner", at);
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore()); failGet = false;
  Object.assign(process.env, { CLINIKO_API_KEY: "k", CLINIKO_USER_AGENT: "kit-test", CLINIKO_SHARD: "au1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "cliniko", op: "patient-form.updatepatientform", input: { params: { id: "9001", expired: true } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "cliniko", op: "patient-form.createpatientform", input: { params: {} }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "cliniko", op: "patient-form.getpatientform", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("creating an agreement form is a live operation: no cron creates one, only an approval does", () => {
  assert.equal((WF.draft_ops.cliniko ?? []).includes("patient-form.createpatientform"), false);
  assert.equal((WF.live_ops.cliniko ?? []).includes("patient-form.createpatientform"), true);
});

test("intake queues one agreement creation per active case for approval, skips closed and malformed cases, and never repeats", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { queued: 2, skipped: 0 });
  assert.equal(writes().length, 0, "no form is created until a person approves it");
  const creations = await approvalsOp(store, "patient-form.createpatientform");
  assert.deepEqual(creations.map((a) => [(a.acts[0].input as any).params.patient_id, (a.acts[0].input as any).params.patient_form_template_id, (a.acts[0].input as any).params.email_to_patient_on_completion]),
    [["7001", "300", false], ["7002", "300", false]]);
  assert.equal(JSON.stringify(creations).includes("evil"), false, "a malformed patient id never reaches the queue");
  assert.deepEqual(await intake(ctx), { queued: 0, skipped: 2 });
  assert.equal((await approvalsOp(store, "patient-form.createpatientform")).length, 2, "re-runs never queue an agreement twice");
  await approveCreations(store, NOW);
  assert.equal(hits.filter((h) => h.method === "POST").length, 2, "one form per case, only after approval");
  assert.equal(writes().some((h) => h.method === "PATCH"), false, "no form a patient sees is changed");
});

test("a malformed agreement template id is refused before any request", async () => {
  const ctx = context(WF, { ...SETTINGS, cliniko: { agreement_template_id: "../x" } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /not a Cliniko id/);
  assert.equal(hits.length, 0);
});

test("chase queues an expiry only after the set days, never runs it itself, and a live approval runs it once", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await approveCreations(store, NOW);
  assert.deepEqual(await chase(context(WF, SETTINGS, store, NOW, () => {})), { queued: 0 }, "not due yet");
  assert.equal(writes().length, 2, "only the two form creations so far");
  assert.deepEqual(await chase(context(WF, SETTINGS, store, LATER, () => {})), { queued: 2 });
  assert.equal(writes().filter((h) => h.method === "PATCH").length, 0, "queued, not run");
  assert.deepEqual(await chase(context(WF, SETTINGS, store, LATER, () => {})), { queued: 0 }, "re-runs never queue twice");
  const pending = await approvalsOp(store, "patient-form.updatepatientform");
  assert.equal(pending.length, 2);
  const ap = pending.find((x) => (x.acts[0].input as any)?.params?.id === "9001")!;
  assert.equal((await approve(WF, store, ap.id, "owner", LATER)).status, "done");
  const patched = writes().filter((h) => h.method === "PATCH");
  assert.equal(patched.length, 1);
  assert.equal(patched[0].path, "/v1/patient_forms/9001");
  assert.deepEqual(patched[0].body, { expired: true });
  await assert.rejects(approve(WF, store, ap.id, "owner", LATER), /already done/);
});

test("a completed agreement is logged once to the register with its signature, and nothing is sent", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await approveCreations(store, NOW);
  forms["9001"].completed = true; forms["9001"].signatures = [{ id: 4455 }];
  const run = CRONS["file-record"]!;
  assert.deepEqual(await run(context(WF, SETTINGS, store, NOW, () => {})), { filed: 1 });
  assert.deepEqual(await run(context(WF, SETTINGS, store, NOW, () => {})), { filed: 0 });
  const reg = await store.get<any>("register", "9001");
  assert.equal(reg.signature_id, "4455");
  assert.equal(reg.signature_read, true);
  assert.equal(writes().filter((h) => h.method === "PATCH").length, 0);
  assert.equal((await approvalsOp(store, "patient-form.updatepatientform")).length, 0, "nothing expired");
});

test("a failed form read stops the run without queuing or recording anything", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await approveCreations(store, NOW);
  failGet = true;
  await assert.rejects(chase(context(WF, SETTINGS, store, LATER, () => {})));
  assert.equal((await approvalsOp(store, "patient-form.updatepatientform")).length, 0);
});

test("an agreement whose creation has not been approved has no form to chase or file, and waits", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(await chase(context(WF, SETTINGS, store, LATER, () => {})), { queued: 0 });
  assert.equal(hits.filter((h) => h.method === "GET" && h.path.startsWith("/v1/patient_forms")).length, 0, "no form is read before one exists");
  await approveCreations(store, LATER);
  assert.deepEqual(await chase(context(WF, SETTINGS, store, LATER, () => {})), { queued: 0 }, "the clock runs from creation, not from the queue");
});

test("every cron in workflow.json has an entry in CRONS", () => {
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `${c.name} has a runner`);
});
