// RFIs workflow, Procore adapter. Every request goes to a fake network: no test reaches a real Procore account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft } from "../industries/construction/workflows/fulfilment/x-rfis/index.ts";
import type { Settings } from "../industries/construction/workflows/fulfilment/x-rfis/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/fulfilment/x-rfis/workflow.json", "utf8")) as WorkflowRecord;
const PROJ = "4242", RFI = 9001;
const BASE = `/rest/v1.0/projects/${PROJ}`;
type Hit = { method: string; path: string; query: URLSearchParams; body: any; headers: Headers };
let hits: Hit[] = [];
let listOut: any[] = [];
// Changed-RFI pages by page number (1-based). Null means the single page in listOut.
let pages: any[][] | null = null;

function fake() {
  hits = []; pages = null;
  listOut = [{ id: RFI, subject: "Ceiling height at gridline C", status: "draft", due_date: null, updated_at: "2026-11-07T12:00:00Z" }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body, headers: new Headers(init?.headers) });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.hostname !== "api.procore.com") return new Response("wrong host", { status: 404 });
      if (p === `${BASE}/rfis` && m === "GET" && pages) return json(pages[Math.min(Number(u.searchParams.get("page") ?? 1), pages.length) - 1]);
      if (p === `${BASE}/rfis` && m === "GET") return json(listOut);
      if (p === `${BASE}/rfis` && m === "POST") return new Response(JSON.stringify({ id: RFI, subject: body?.rfi?.subject, draft: true }), { status: 201, headers: { "content-type": "application/json" } });
      if (p === `${BASE}/rfis/${RFI}` && m === "PATCH") return json({ id: RFI, status: "open" });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const opens = () => hits.filter((h) => h.method === "PATCH");
const S: Settings = { business_name: "Test Builders", procore: { projects: [PROJ], rfi_manager_id: 5, default_assignee_id: 77, default_due_days: 7 } };
const NOW = new Date("2026-11-08T00:00:00Z");
const QUESTION = { id: "q1", project: PROJ, name: "Ceiling height at gridline C", question: "A-201 shows 2.7 m, S-101 shows 2.4 m. Which governs?", status: "new" as const };
const row = (id: number, updated: string) => ({ id, subject: `RFI ${id}`, status: "draft", due_date: null, updated_at: updated });

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PROCORE_ACCESS_TOKEN: "pc-token", PROCORE_COMPANY_ID: "777", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft the open and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "procore", op: "rfis.update-rfi", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "procore", op: "rfis.list-rfis", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("setting both fieldwire and procore is refused before any call", async () => {
  const ctx = context(WF, { ...S, fieldwire: { api_version: "2026-10-01", projects: ["11111111-2222-4333-8444-555555555555"] } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /either fieldwire or procore/);
  assert.equal(hits.length, 0);
});

test("intake keeps each changed RFI once, reads only, sends the company header, and moves the watermark on", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { seen: 1, added: 1 });
  assert.equal(hits[0].query.get("filters[updated_at]"), "2026-11-07T00:00:00Z...2026-11-08T00:00:00Z", "the first run looks back one day, whole seconds");
  assert.equal(hits[0].query.get("page"), "1"); assert.equal(hits[0].query.get("per_page"), "100");
  assert.equal(hits[0].headers.get("procore-company-id"), "777");
  assert.equal(hits[0].headers.get("authorization"), "Bearer pc-token");
  assert.deepEqual(await store.get("watermarks", `rfis:${PROJ}`), { at: "2026-11-07T12:00:00Z" });
  assert.deepEqual(await intake(ctx), { seen: 1, added: 0 }, "the same RFI on a second run is not new");
  assert.equal(hits[1].query.get("filters[updated_at]"), "2026-11-07T12:00:00Z...2026-11-08T00:00:00Z", "the second run asks only for changes");
  assert.equal(writes().length, 0, "intake reads only");
});

test("intake follows a full page into the next and keeps the RFIs from both", async () => {
  pages = [Array.from({ length: 100 }, (_, i) => row(1000 + i, "2026-11-07T12:00:00Z")), [row(2000, "2026-11-07T13:00:00Z")]];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { seen: 101, added: 101 });
  assert.deepEqual(hits.filter((h) => h.method === "GET").map((h) => h.query.get("page")), ["1", "2"]);
  assert.ok(await store.get("rfis", "2000"), "the second page's RFI is kept");
  assert.deepEqual(await store.get("watermarks", `rfis:${PROJ}`), { at: "2026-11-07T13:00:00Z" });
});

test("intake: a window past the page cap is refused whole and the watermark is held", async () => {
  pages = [Array.from({ length: 100 }, (_, i) => row(3000 + i, "2026-11-07T12:00:00Z"))];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { seen: 0, added: 0 });
  assert.equal(hits.filter((h) => h.method === "GET").length, 20, "stops at the page cap");
  assert.equal(await store.get("watermarks", `rfis:${PROJ}`), undefined, "the watermark does not move");
  assert.deepEqual(Object.keys(await store.list("rfis")), [], "nothing is kept from a refused window");
});

test("rows with a missing or non-integer id are skipped", async () => {
  listOut = [{ id: "abc", subject: "x", updated_at: "2026-11-07T12:00:00Z" }, { subject: "y" }, row(RFI, "2026-11-07T12:00:00Z")];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { seen: 1, added: 1 });
});

test("draft creates the RFI as a draft with its question and manager, and queues the open without sending it", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", QUESTION);
  assert.deepEqual(await draft(ctx), { created: 1, queued: 1, needs_assignee: 0 });
  assert.deepEqual(writes().map((h) => `${h.method} ${h.path}`), [`POST ${BASE}/rfis`], "only the draft is created");
  assert.deepEqual(writes()[0].body, { rfi: { subject: "Ceiling height at gridline C", question: { body: QUESTION.question }, rfi_manager_id: 5, draft: true } });
  assert.equal(opens().length, 0, "the open is queued, not sent");
  const q = (await store.get<any>("questions", "q1")) as any;
  assert.equal(q.rfi_id, String(RFI)); assert.equal(q.status, "queued"); assert.equal(q.question_set, true);
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1); assert.equal(pending[0].status, "pending");
  assert.match(pending[0].summary, /to user 77, due 2026-11-15 \(Procore notifies them\)/);
});

test("a rerun never creates a second RFI or queues a second open", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", QUESTION);
  await draft(ctx);
  const before = writes().length;
  assert.deepEqual(await draft(ctx), { created: 0, queued: 0, needs_assignee: 0 });
  assert.equal(writes().length, before, "no new calls on the rerun");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
});

test("an approved open runs the update with draft false, the assignee and the due date", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", QUESTION);
  await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(opens().length, 1);
  assert.equal(opens()[0].path, `${BASE}/rfis/${RFI}`);
  assert.deepEqual(opens()[0].body, { rfi: { draft: false, assignee_ids: [77], due_date: "2026-11-15" } });
  assert.equal(opens()[0].headers.get("procore-company-id"), "777");
});

test("a question with no assignee is parked after the draft is made, with no open queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S, procore: { ...S.procore!, default_assignee_id: undefined } }, store, NOW, () => {});
  await store.put("questions", "q1", QUESTION);
  assert.deepEqual(await draft(ctx), { created: 1, queued: 0, needs_assignee: 1 });
  assert.equal(((await store.get<any>("questions", "q1")) as any).status, "needs-assignee");
  assert.equal(Object.values(await store.list("approvals")).length, 0);
});

test("a business with no RFI manager parks the question with that reason and makes no call", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S, procore: { ...S.procore!, rfi_manager_id: undefined as any } }, store, NOW, () => {});
  await store.put("questions", "q1", QUESTION);
  assert.deepEqual(await draft(ctx), { created: 0, queued: 0, needs_assignee: 1 });
  const q = (await store.get<any>("questions", "q1")) as any;
  assert.equal(q.status, "needs-person"); assert.match(q.reason, /rfi_manager_id/);
  assert.equal(hits.length, 0);
});

test("ids from settings and rows are checked before any call", async () => {
  const ctx = context(WF, { ...S, procore: { ...S.procore!, projects: ["abc"] } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /bad id/);
  const ctx0 = context(WF, { ...S, procore: { ...S.procore!, projects: ["../1"] } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx0), /bad store name/, "a path-like id never reaches the store or the network");
  const store = new MemoryStore(), ctx2 = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", { ...QUESTION, project: "4242/../9" });
  assert.deepEqual(await draft(ctx2), { created: 0, queued: 0, needs_assignee: 1 });
  assert.match(((await store.get<any>("questions", "q1")) as any).reason, /bad id/);
  assert.equal(hits.length, 0);
});

test("one question with a bad due date is parked with its reason; the questions after it still run", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", { ...QUESTION, due_date: "next week" });
  await store.put("questions", "q2", { ...QUESTION, id: "q2", rfi_id: String(RFI), question_set: true });
  assert.deepEqual(await draft(ctx), { created: 1, queued: 1, needs_assignee: 1 });
  const q1 = (await store.get<any>("questions", "q1")) as any, q2 = (await store.get<any>("questions", "q2")) as any;
  assert.equal(q1.status, "needs-person"); assert.match(q1.reason, /due must be a date/);
  assert.equal(q2.status, "queued");
  assert.equal(q1.rfi_id, String(RFI), "the RFI made for the bad question is kept, so a retry never makes a second one");
});

test("the approval shows the RFI name escaped", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", { ...QUESTION, name: 'Is it <b>2.4</b> & "why"?' });
  await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.match(ap.summary, /Is it &lt;b&gt;2\.4&lt;\/b&gt; &amp; &quot;why&quot;\?/);
});
