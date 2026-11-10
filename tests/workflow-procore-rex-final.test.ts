// Regression coverage for the new Procore change-order and Rex feedback/call-note paths.
// Copy this file into tests/ before running; imports intentionally use that directory's ../ paths.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { changeOrders, trackOrders } from "../industries/construction/workflows/sales/variations/adapters/procore.ts";
import { intake as inspectionsIntake, draft as inspectionsDraft, report as inspectionsReport } from "../industries/real-estate/workflows/fulfilment/inspections/index.ts";
import { queueCallNotes } from "../industries/real-estate/workflows/sales/calls/adapters/rex.ts";

const procoreWF = JSON.parse(fs.readFileSync("industries/construction/workflows/sales/variations/workflow.json", "utf8")) as WorkflowRecord;
const inspectionsWF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/fulfilment/inspections/workflow.json", "utf8")) as WorkflowRecord;
const callsWF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/sales/calls/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-11T00:00:00Z");

function fakeCtx(workflow: WorkflowRecord, settings: any, store = new MemoryStore(), pages?: (a: any) => any) {
  const calls: any[] = [], queued: any[] = [];
  const ctx: any = {
    workflow, settings, store, now: NOW, log() {},
    async draft(a: any) { calls.push(a); return { status: 200, data: pages ? pages(a) : {} }; },
    async queue(a: any, summary?: string) { queued.push({ a, summary }); return `approval-${queued.length}`; },
  };
  return { ctx, calls, queued, store };
}

const pcSettings = { platform: "procore", procore: { projects: [{ id: "41", name: "North" }] } };

test("Procore reads Prime and Commitment COs from their distinct documented endpoints and stores separate snapshots", async () => {
  const h = fakeCtx(procoreWF, pcSettings, undefined, (a) => {
    const kind = a.op.startsWith("prime-") ? "prime" : "commitment";
    const page = a.input.params.page;
    if (page === 1) return [{ id: kind === "prime" ? 17 : 17, number: `${kind}-17`, status: "approved", title: `${kind} title` }];
    return [];
  });
  assert.deepEqual(await trackOrders(h.ctx), { tracked: 2 });
  assert.deepEqual(h.calls.map((c) => c.op), [
    "prime-change-orders.show-all-prime-change-orders", "prime-change-orders.show-all-prime-change-orders",
    "commitment-change-orders.show-all-commitment-change-orders", "commitment-change-orders.show-all-commitment-change-orders",
  ]);
  assert.ok(h.calls.every((c) => c.input.params.project_id === 41 && c.input.params.per_page === 100));
  assert.equal((await h.store.get<any>("procore-orders", "41:prime")).rows[0].number, "prime-17");
  assert.equal((await h.store.get<any>("procore-orders", "41:commitment")).rows[0].number, "commitment-17");
  assert.equal(h.queued.length, 0, "tracking queues no approval or live change");
});

test("Procore malformed or truncated paginated CO reads reject without replacing either prior snapshot", async () => {
  const store = new MemoryStore();
  await store.put("procore-orders", "41:prime", { read_at: "old-prime", rows: [{ id: "1" }] });
  await store.put("procore-orders", "41:commitment", { read_at: "old-commitment", rows: [{ id: "2" }] });
  let mode = "malformed";
  const h = fakeCtx(procoreWF, pcSettings, store, (a) => {
    if (mode === "malformed") return a.input.params.page === 1 ? [{ id: "../bad" }] : [];
    return a.input.params.page === 1 ? [{ id: 3 }] : [{ id: 3 }];
  });
  await assert.rejects(changeOrders(h.ctx, "41", "prime"), /bad id/);
  assert.equal((await store.get<any>("procore-orders", "41:prime")).read_at, "old-prime");
  mode = "duplicate";
  await assert.rejects(changeOrders(h.ctx, "41", "commitment"), /repeated change order/);
  assert.equal((await store.get<any>("procore-orders", "41:commitment")).read_at, "old-commitment");
});

test("Rex inspections intake stores active viewing feedback only; report and draft remain no-ops", async () => {
  const h = fakeCtx(inspectionsWF, { platform: "rex" }, undefined, (a) => ({ result: {
    total: 3,
    rows: a.input.params.offset === 0 ? [
      { id: 10, feedback_type: { id: "inspection" }, system_record_state: "active", date_of: "2026-11-10", note: "Viewed", listing: { id: 7 } },
      { id: 11, feedback_type: { id: "owner" }, system_record_state: "active", note: "Owner note" },
    ] : a.input.params.offset === 2 ? [{ id: 12, feedback_type: { id: "inspection" }, system_record_state: "deleted", note: "Old" }] : [],
  }, error: null }));
  assert.deepEqual(await inspectionsIntake(h.ctx), { viewings: 1 });
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every((c) => c.op === "feedback.search" && c.input.params.limit === 50));
  assert.deepEqual((await h.store.get<any>("rex-viewings", "current")).records["10"], { id: "10", date: "2026-11-10", note: "Viewed", listing: "7" });
  assert.deepEqual(await inspectionsDraft(h.ctx), { drafted: 0 });
  assert.deepEqual(await inspectionsReport(h.ctx), { queued: 0, waiting: 0 });
  assert.equal(h.calls.length, 3, "Rex has no condition-report calls");
  assert.equal(h.queued.length, 0, "Rex viewing feedback creates no report approval");
});

test("Rex malformed and short feedback pages preserve the prior snapshot", async () => {
  const store = new MemoryStore();
  await store.put("rex-viewings", "current", { read_at: "before", records: { "9": { id: "9", note: "prior" } } });
  let mode = "malformed";
  const h = fakeCtx(inspectionsWF, { platform: "rex" }, store, (a) => mode === "malformed"
    ? { result: { total: 1, rows: [{ id: "bad", feedback_type: { id: "inspection" } }] }, error: null }
    : a.input.params.offset === 0 ? { result: { total: 2, rows: [{ id: 13, feedback_type: { id: "inspection" } }] }, error: null } : { result: { total: 2, rows: [] }, error: null });
  await assert.rejects(inspectionsIntake(h.ctx), /invalid or repeated feedback id/);
  assert.equal((await store.get<any>("rex-viewings", "current")).read_at, "before");
  mode = "short";
  await assert.rejects(inspectionsIntake(h.ctx), /incomplete feedback list/);
  assert.equal((await store.get<any>("rex-viewings", "current")).read_at, "before");
});

test("Rex call notes wait for approval, use the documented note body, dedupe, and requeue changed text", async () => {
  const store = new MemoryStore();
  await store.put("rex-call-notes", "call-1", { contact_id: "52", text: "Called about the appraisal." });
  const ctx = context(callsWF, { platform: "rex" }, store, NOW, () => {});
  assert.deepEqual(await queueCallNotes(ctx), { queued: 1 });
  // Resolve the queued approval through its marker so the assertion does not guess its digest.
  const queuedRows = await store.list<any>("rex-call-notes-queued");
  const marker = Object.values(queuedRows)[0];
  assert.ok(marker?.approval, "an approval was queued");
  const approvals = await store.list<any>("approvals");
  const approval = Object.values(approvals).find((a: any) => a.acts?.[0]?.op === "notes.create");
  assert.ok(approval, "Rex note creation exists only as a pending approval");
  const act = approval!.acts[0];
  assert.deepEqual(act.input.params.data, { note: "Called about the appraisal.", note_type: { id: "phonecall" }, _related: { note_contacts: [{ contact_id: 52 }] }, update_last_contacted: false });
  assert.deepEqual(act.check, { platform: "rex", op: "contacts.read", input: { params: { id: 52 } }, expect: [{ path: "result.id", equals: "52" }] });
  assert.equal(approval!.status, "pending");
  assert.deepEqual(await queueCallNotes(ctx), { queued: 0 }, "same note is not queued twice");
  await store.put("rex-call-notes", "call-1", { contact_id: "52", text: "Called again about the appraisal." });
  assert.deepEqual(await queueCallNotes(ctx), { queued: 1 }, "changed text receives a distinct approval");
  assert.equal(Object.values(await store.list<any>("approvals")).filter((a) => a.acts?.[0]?.op === "notes.create").length, 2);
});

test("Rex call notes reject malformed operator input before creating any approval", async () => {
  const store = new MemoryStore();
  await store.put("rex-call-notes", "bad-contact", { contact_id: "1/contacts/evil", text: "Actual call" });
  const ctx = context(callsWF, { platform: "rex" }, store, NOW, () => {});
  await assert.rejects(queueCallNotes(ctx), /invalid call note/);
  assert.deepEqual(await store.list("approvals"), {});
  await store.put("rex-call-notes", "bad-text", { contact_id: "53", text: "   " });
  await assert.rejects(queueCallNotes(ctx), /invalid call note/);
  assert.deepEqual(await store.list("approvals"), {});
});

import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { approve } from "../core/workflows/runtime.ts";
// Append-ready integration regression for the Rex call-note approval boundary.
// Imports use ../ paths because this is intended to be appended to a file in tests/.

const CALL_NOTES_WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/sales/calls/workflow.json", "utf8")) as WorkflowRecord;
const CALL_NOTES_NOW = new Date("2026-11-11T00:00:00Z");

test("Rex call-note approval checks the contact before sending the exact notes.create body", async () => {
  const store = new MemoryStore();
  await store.put("rex-call-notes", "call-1", { contact_id: "52", text: "Discussed the appraisal timeline." });
  const hits: { path: string; method: string; body: any; authorization: string | null }[] = [];
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { REX_ACCESS_TOKEN: "test-rex-token", KIT_ALLOW_WRITES: "1" });
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
    const u = new URL(String(url));
    let body: any;
    try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
    hits.push({ path: u.pathname, method: init?.method ?? "GET", body, authorization: new Headers(init?.headers).get("authorization") });
    if (u.hostname !== "api.rexsoftware.com") return new Response("wrong host", { status: 404 });
    if (u.pathname === "/v1/rex/contacts/read") return new Response(JSON.stringify({ result: { id: "52" }, error: null }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/rex/notes/create") return new Response(JSON.stringify({ result: { id: 901 }, error: null }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not faked: " + u.pathname, { status: 404 });
  }) as any });

  const ctx = context(CALL_NOTES_WF, { platform: "rex" }, store, CALL_NOTES_NOW, () => {});
  assert.deepEqual(await queueCallNotes(ctx), { queued: 1 });
  assert.equal(hits.length, 0, "queueing leaves both Rex operations untouched pending approval");
  const queued = Object.values(await store.list<any>("rex-call-notes-queued"))[0];
  const result = await approve(CALL_NOTES_WF, store, queued.approval, "reviewer", CALL_NOTES_NOW);
  assert.equal(result.status, "done");
  assert.deepEqual(hits.map((h) => h.path), ["/v1/rex/contacts/read", "/v1/rex/notes/create"]);
  assert.ok(hits.every((h) => h.method === "POST" && h.authorization === "Bearer test-rex-token"));
  assert.deepEqual(hits[0].body, { id: 52 });
  assert.deepEqual(hits[1].body, { data: {
    note: "Discussed the appraisal timeline.",
    note_type: { id: "phonecall" },
    _related: { note_contacts: [{ contact_id: 52 }] },
    update_last_contacted: false,
  } });
});

test("Rex call-note approval refuses changed or missing contacts before notes.create", async (t) => {
  for (const scenario of [
    { name: "changed contact id", reply: { result: { id: "99" }, error: null } },
    { name: "missing contact id", reply: { result: null, error: null } },
  ]) {
    await t.test(scenario.name, async () => {
      const store = new MemoryStore();
      await store.put("rex-call-notes", "call-1", { contact_id: "52", text: "Discussed the appraisal timeline." });
      const hits: string[] = [];
      setTokenStore(new MemoryTokenStore());
      Object.assign(process.env, { REX_ACCESS_TOKEN: "test-rex-token", KIT_ALLOW_WRITES: "1" });
      setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any) => {
        const u = new URL(String(url)); hits.push(u.pathname);
        if (u.hostname !== "api.rexsoftware.com" || u.pathname !== "/v1/rex/contacts/read") return new Response("write must not occur", { status: 500 });
        return new Response(JSON.stringify(scenario.reply), { status: 200, headers: { "content-type": "application/json" } });
      }) as any });
      const ctx = context(CALL_NOTES_WF, { platform: "rex" }, store, CALL_NOTES_NOW, () => {});
      await queueCallNotes(ctx);
      const queued = Object.values(await store.list<any>("rex-call-notes-queued"))[0];
      const result = await approve(CALL_NOTES_WF, store, queued.approval, "reviewer", CALL_NOTES_NOW);
      assert.equal(result.status, "rejected");
      assert.deepEqual(hits, ["/v1/rex/contacts/read"], "notes.create is never reached after a stale or missing contact check");
    });
  }
});
