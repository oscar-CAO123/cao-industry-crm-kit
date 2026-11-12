// Breakdown fix finder tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { intake, diagnose, escalate, record } from "../industries/manufacturing/workflows/fulfilment/faultfind/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/manufacturing/workflows/fulfilment/faultfind/workflow.json", "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", PRIOR = "22222222-3333-4444-8555-666666666666";
const CO = "33333333-4444-4555-8666-777777777777", MAT = "44444444-5555-4666-8777-888888888888", NOTE = "55555555-6666-4777-8888-999999999999";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let jobStatus = "Work Order";

function fake() {
  hits = []; jobStatus = "Work Order";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname, f = u.searchParams.get("$filter") ?? "";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (p.endsWith("/job.json") && m === "GET") {
        if (/^uuid eq/.test(f)) return json([{ uuid: JOB, status: jobStatus, active: 1, company_uuid: CO, job_description: "Conveyor motor tripping", date: "2026-11-09" }]);
        if (f.includes("company_uuid eq")) return json([
          { uuid: PRIOR, status: "Completed", active: 1, company_uuid: CO, job_description: "Drive end bearing", date: "2026-06-01" },
          { uuid: JOB, status: jobStatus, active: 1, company_uuid: CO, job_description: "Conveyor motor tripping", date: "2026-11-09" }]);
        return json([{ uuid: JOB, status: "Work Order", active: 1, company_uuid: CO, job_description: "Conveyor motor tripping", job_address: "2 Factory Rd", date: "2026-11-09" }]);
      }
      if (p.endsWith("/note.json")) {
        if (m === "POST") return json({ errorCode: 0 }, { "x-record-uuid": NOTE });
        return json(f.includes(`related_object_uuid eq '${PRIOR}'`) ? [{ note: "Replaced drive end bearing, checked alignment" }] : []);
      }
      if (p.endsWith("/material.json")) return json([{ uuid: MAT, name: "Bearing 6205", quantity_in_stock: 4, active: 1 }]);
      if (p.endsWith("/jobmaterial.json")) return json([{ name: "Bearing 6205", quantity: "1" }]);
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/platform_service_email"));
const notesWritten = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/note.json"));
const S: any = { business_name: "Test Manufacturing", breakdown_status: "Work Order", escalate_after_hours: 4, escalation_email: "maint@example.com.au" };
const NOW = new Date("2026-11-09T00:00:00Z");
const LATER = new Date("2026-11-09T05:00:00Z");

beforeEach(() => {
  fake();
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run the email, and cannot queue a note", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createNotes", summary: "x" }), /not a live operation/);
});

test("intake: each open breakdown becomes one fault, and a re-run adds none", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await intake(ctx), { added: 0 });
  const f = await store.get<any>("faults", `servicem8:${JOB}`);
  assert.equal(f.status, "new");
});

test("diagnose: drafts one note from history and stock, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await diagnose(ctx), { drafted: 1 });
  assert.equal(notesWritten().length, 1);
  const note = notesWritten()[0].body.note as string;
  assert.match(note, /Replaced drive end bearing/);
  assert.match(note, /Bearing 6205 \(4 in stock\)/);
  assert.equal(sends().length, 0);
  assert.equal((await store.get<any>("faults", `servicem8:${JOB}`)).status, "triaged");
  assert.deepEqual(await diagnose(ctx), { drafted: 0 });
  assert.equal(notesWritten().length, 1);
});

test("escalate: queues one email after the window, nothing sends, and a re-run queues nothing more", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await diagnose(ctx);
  assert.deepEqual(await escalate(context(WF, S, store, NOW, () => {})), { queued: 0, closed: 0 });
  const late = context(WF, S, store, LATER, () => {});
  assert.deepEqual(await escalate(late), { queued: 1, closed: 0 });
  assert.deepEqual(await escalate(context(WF, S, store, LATER, () => {})), { queued: 0, closed: 0 });
  assert.equal(sends().length, 0);
  const id = approvalId(WF.id, `escalate:servicem8:${JOB}`);
  assert.equal((await store.get<any>("approvals", id))?.status, "pending");
});

test("approval: an approved escalation sends once", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await diagnose(context(WF, S, store, NOW, () => {}));
  await escalate(context(WF, S, store, LATER, () => {}));
  const id = approvalId(WF.id, `escalate:servicem8:${JOB}`);
  const ap = await approve(WF, store, id, "tester", LATER);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].body.to, "maint@example.com.au");
  await assert.rejects(approve(WF, store, id, "tester", LATER), /already done/);
  assert.equal(sends().length, 1);
});

test("escalate: a job closed in ServiceM8 is not escalated", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await diagnose(context(WF, S, store, NOW, () => {}));
  jobStatus = "Unsuccessful";
  assert.deepEqual(await escalate(context(WF, S, store, LATER, () => {})), { queued: 0, closed: 1 });
  assert.equal(sends().length, 0);
});

test("record: a completed job gets a repair note from the parts used, and no email", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await diagnose(context(WF, S, store, NOW, () => {}));
  jobStatus = "Completed";
  assert.deepEqual(await record(context(WF, S, store, LATER, () => {})), { recorded: 1 });
  const last = notesWritten().at(-1)!.body.note as string;
  assert.match(last, /Bearing 6205 x1/);
  assert.equal(sends().length, 0);
  assert.deepEqual(await record(context(WF, S, store, LATER, () => {})), { recorded: 0 });
});

test("validation: a status name with symbols is refused before any call", async () => {
  const ctx = context(WF, { ...S, breakdown_status: "Work' or 1=1" }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /breakdown_status must be letters/);
  assert.equal(hits.length, 0);
});

test("escalate: a job title with line breaks cannot change the email subject", async () => {
  const store = new MemoryStore();
  const id = `servicem8:${JOB}`;
  await store.put("faults", id, { id, job_uuid: JOB, company_uuid: CO, title: "Conveyor motor tripping\r\nBcc: someone@example.com",
    text: "Motor trips", address: "2 Factory Rd", seen: NOW.toISOString(), status: "triaged" });
  assert.deepEqual(await escalate(context(WF, S, store, LATER, () => {})), { queued: 1, closed: 0 });
  const [ap] = Object.values(await store.list<any>("approvals"));
  const subject: string = ap.acts[0].input.body.subject;
  assert.doesNotMatch(subject, /[\u0000-\u001f\u007f]/, "no control characters in the subject");
  assert.equal(subject, "Breakdown still open: Conveyor motor tripping  Bcc: someone@example.com");
  assert.equal(sends().length, 0);
});
