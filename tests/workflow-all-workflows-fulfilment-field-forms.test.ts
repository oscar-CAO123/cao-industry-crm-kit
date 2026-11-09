// Field-forms workflow tests. Every request goes to a fake network: no test reaches a real Fieldwire account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, checklists, report } from "../industries/all/workflows/fulfilment/field-forms/index.ts";
import type { Settings } from "../industries/all/workflows/fulfilment/field-forms/types.ts";

const WF = JSON.parse(await (await import("node:fs/promises")).readFile("industries/all/workflows/fulfilment/field-forms/workflow.json", "utf8")) as WorkflowRecord;
const PROJ = "11111111-2222-4333-8444-555555555555", FORM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", TPL = "99999999-8888-4777-8666-555555555555";
const DONE = "12345678-1234-4234-8234-123456789012", OPEN = "87654321-4321-4321-8321-210987654321";
const TASK = "abcdefab-cdef-4abc-8def-abcdefabcdef", CHK1 = "11112222-3333-4444-8555-666677778888", CHK2 = "21112222-3333-4444-8555-666677778888";
const UPDATED = "2026-11-07T12:00:00Z";
type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let formsOut: any[] = [];

function fake() {
  hits = []; formsOut = [{ id: FORM, name: "Pre-start\nchecklist", form_template_id: TPL, form_template_form_status_id: DONE, project_id: PROJ,
    kind: "default", created_at: "2026-11-07T09:00:00Z", updated_at: UPDATED }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === `/api/v3/projects/${PROJ}/forms` && m === "GET") return json(formsOut);
      if (p === `/api/v3/projects/${PROJ}/tasks` && m === "GET") return json([{ id: TASK, name: "Hot water install", start_at: "2026-11-08T07:00:00Z" }]);
      if (p === `/api/v3/projects/${PROJ}/tasks/${TASK}/task_check_items` && m === "GET") return json([{ id: CHK1, checked: true }, { id: CHK2, checked: false }]);
      if (p === `/api/v3/projects/${PROJ}/forms/${FORM}/email` && m === "POST") return json({});
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const emails = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/email"));
const writes = () => hits.filter((h) => h.method !== "GET");
const S: Settings = { business_name: "Test Builders", fieldwire: { api_version: "2026-10-01", projects: [PROJ], complete_status_ids: [DONE],
  report_recipients: "owner@example.com.au, ops@example.com.au", report_cc_sender: true } };
const NOW = new Date("2026-11-08T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { FIELDWIRE_ACCESS_TOKEN: "fw", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft the emailing operation and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "fieldwire", op: "fieldwire-regional-api.email_by_form_id", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "fieldwire", op: "fieldwire-regional-api.get_forms_in_project", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("the version header is required before any Fieldwire call", async () => {
  const ctx = context(WF, { ...S, fieldwire: { ...S.fieldwire, api_version: "" } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /fieldwire.api_version/);
  assert.equal(hits.length, 0);
});

test("intake keeps each changed form once and moves the watermark on", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { seen: 1, added: 1 });
  assert.equal(hits[0].query.get("filters[updated_at_gt]"), "2026-11-07T00:00:00.000Z", "the first run looks back one day");
  assert.equal(((await store.get<any>("forms", FORM)) as any).name, "Pre-start checklist", "control characters are cleaned");
  assert.deepEqual(await store.get("watermarks", `forms:${PROJ}`), { at: UPDATED });
  assert.deepEqual(await intake(ctx), { seen: 1, added: 0 }, "the same form on a second run is not new");
  assert.equal(hits[1].query.get("filters[updated_at_gt]"), UPDATED, "the second run asks only for changes since the first");
  assert.equal(writes().length, 0, "intake reads only");
});

test("checklists count open items on tasks starting near now, read only", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await checklists(ctx), { tasks: 1, with_open_items: 1 });
  assert.deepEqual(await store.get<any>("checklists", TASK).then((r) => [r.total, r.open]), [2, 1]);
  assert.equal(writes().length, 0);
});

test("report queues one PDF email per completed form; a cron never sends; re-runs never double-queue", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await report(ctx), { queued: 1 });
  assert.equal(emails().length, 0, "nothing emailed by a cron");
  assert.deepEqual(await report(ctx), { queued: 1 });
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1, "re-runs never queue twice");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  const sent = emails()[0];
  assert.equal(sent.path, `/api/v3/projects/${PROJ}/forms/${FORM}/email`);
  assert.deepEqual(sent.body, { email: "owner@example.com.au,ops@example.com.au", cc_sender: true, subject: "Test Builders: Pre-start checklist", body: `Attached is the completed form "Pre-start checklist", completed 2026-11-07.`, kind: "pdf" });
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("report queues nothing until a complete status is set, and rejects a bad recipient before queueing", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await report(context(WF, { ...S, fieldwire: { ...S.fieldwire, complete_status_ids: [] } }, store, NOW, () => {})), { queued: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  await assert.rejects(report(context(WF, { ...S, fieldwire: { ...S.fieldwire, report_recipients: "not-an-address" } }, store, NOW, () => {})), /comma-separated email/);
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("a capped run carries the forms it left out to the next run, even after they leave the 24-hour window", async () => {
  const LATER = "cccccccc-dddd-4eee-8fff-000000000001";
  formsOut = [
    { id: FORM, name: "Pre-start checklist", form_template_id: TPL, form_template_form_status_id: DONE, project_id: PROJ, kind: "default", created_at: "2026-11-07T09:00:00Z", updated_at: UPDATED },
    { id: LATER, name: "Hot works permit", form_template_id: TPL, form_template_form_status_id: DONE, project_id: PROJ, kind: "default", created_at: "2026-11-07T10:00:00Z", updated_at: "2026-11-07T13:00:00Z" },
  ];
  const capped = { ...S, fieldwire: { ...S.fieldwire, report_max_per_run: 1 } };
  const store = new MemoryStore();
  await intake(context(WF, capped, store, NOW, () => {}));
  assert.deepEqual(await report(context(WF, capped, store, NOW, () => {})), { queued: 1 });
  const NEXT = new Date("2026-11-09T22:00:00Z");  // both forms are now older than the 24-hour window
  await intake(context(WF, capped, store, NEXT, () => {}));
  assert.deepEqual(await report(context(WF, capped, store, NEXT, () => {})), { queued: 1 }, "the form the cap left behind is queued on the next run");
  const ids = Object.values(await store.list<Approval>("approvals")).map((a) => a.acts[0].input?.params?.id).sort();
  assert.deepEqual(ids, [FORM, LATER].sort(), "each form is queued exactly once");
  assert.equal((await store.get<any>("forms", LATER))!.carry, undefined, "the carry marker is cleared once queued");
});
