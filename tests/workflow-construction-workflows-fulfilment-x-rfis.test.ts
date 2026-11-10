// RFIs workflow tests. Every request goes to a fake network: no test reaches a real Fieldwire account.
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
const PROJ = "11111111-2222-4333-8444-555555555555", RFI = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BASE = `/api/v3/projects/${PROJ}`;
type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let rfisOut: any[] = [];
// Changed-RFI pages, served by last_synced_at: "syncN" asks for page N (0-based). Null means the single page in rfisOut.
let rfiPages: { rows: any[]; more: boolean }[] | null = null;
const RFI2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";

function fake() {
  hits = []; rfiPages = null;
  rfisOut = [{ id: RFI, name: "Ceiling height at gridline C", mapped_status: "draft", due_date: null, updated_at: "2026-11-07T12:00:00Z" }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === `${BASE}/rfis` && m === "GET" && rfiPages) {
        const i = Number(u.searchParams.get("last_synced_at")?.replace("sync", "") ?? 0), pg = rfiPages[Math.min(i, rfiPages.length - 1)];
        const headers: Record<string, string> = { "content-type": "application/json", has_more: String(pg.more) };
        if (pg.more) headers.last_synced_at = `sync${i + 1}`;
        return new Response(JSON.stringify(pg.rows), { status: 200, headers });
      }
      if (p === `${BASE}/rfis` && m === "GET") return json(rfisOut);
      if (p === `${BASE}/rfis` && m === "POST") return json({ id: RFI, name: body?.name });
      if (p === `${BASE}/rfis/${RFI}` && m === "PATCH") return json({ id: RFI });
      if (p === `${BASE}/rfis/${RFI}/transition` && m === "PATCH") return json({ id: RFI, status: "open" });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const opens = () => hits.filter((h) => h.path.endsWith("/transition"));
const S: Settings = { business_name: "Test Builders", fieldwire: { api_version: "2026-10-01", projects: [PROJ], designer_user_id: 42, default_due_days: 7 } };
const NOW = new Date("2026-11-08T00:00:00Z");
const QUESTION = { id: "q1", project: PROJ, name: "Ceiling height at gridline C", question: "A-201 shows 2.7 m, S-101 shows 2.4 m. Which governs?", status: "new" as const };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { FIELDWIRE_ACCESS_TOKEN: "fw", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft the open and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "fieldwire", op: "fieldwire-regional-api.transition_rfi_in_project", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "fieldwire", op: "fieldwire-regional-api.get_rfis_in_project", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("the version header is required before any Fieldwire call", async () => {
  const ctx = context(WF, { ...S, fieldwire: { ...S.fieldwire!, api_version: "" } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /fieldwire.api_version/);
  assert.equal(hits.length, 0);
});

test("intake keeps each changed RFI once, reads only, and moves the watermark on", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { seen: 1, added: 1 });
  assert.equal(hits[0].query.get("filters[updated_at_gt]"), "2026-11-07T00:00:00.000Z", "the first run looks back one day");
  assert.deepEqual(await store.get("watermarks", `rfis:${PROJ}`), { at: "2026-11-07T12:00:00Z" });
  assert.deepEqual(await intake(ctx), { seen: 1, added: 0 }, "the same RFI on a second run is not new");
  assert.equal(hits[1].query.get("filters[updated_at_gt]"), "2026-11-07T12:00:00Z", "the second run asks only for changes");
  assert.equal(writes().length, 0, "intake reads only");
});

test("intake follows two pages by last_synced_at and keeps the RFIs from both", async () => {
  const row = (id: string, updated: string) => ({ id, name: `RFI ${id.slice(-4)}`, mapped_status: "draft", due_date: null, updated_at: updated });
  rfiPages = [{ rows: [row(RFI, "2026-11-07T12:00:00Z")], more: true }, { rows: [row(RFI2, "2026-11-07T13:00:00Z")], more: false }];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { seen: 2, added: 2 });
  const gets = hits.filter((h) => h.method === "GET" && h.path === `${BASE}/rfis`);
  assert.deepEqual(gets.map((h) => h.query.get("last_synced_at")), [null, "sync1"], "page two is asked with the token from page one");
  assert.ok(await store.get("rfis", RFI2), "the second page's RFI is kept");
  assert.deepEqual(await store.get("watermarks", `rfis:${PROJ}`), { at: "2026-11-07T13:00:00Z" });
  assert.equal(writes().length, 0, "intake reads only");
});

test("intake: a window past the page cap is refused whole and the watermark is held", async () => {
  rfiPages = Array.from({ length: 25 }, () => ({ rows: [], more: true }));
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { seen: 0, added: 0 });
  assert.equal(hits.filter((h) => h.method === "GET" && h.path === `${BASE}/rfis`).length, 20, "stops at the page cap");
  assert.equal(await store.get("watermarks", `rfis:${PROJ}`), undefined, "the watermark does not move");
  assert.deepEqual(Object.keys(await store.list("rfis")), [], "nothing is kept from a refused window");
});

test("draft creates the RFI draft, sets its question, and queues the open without sending it", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", QUESTION);
  assert.deepEqual(await draft(ctx), { created: 1, queued: 1, needs_assignee: 0 });
  assert.deepEqual(writes().map((h) => `${h.method} ${h.path}`), [`POST ${BASE}/rfis`, `PATCH ${BASE}/rfis/${RFI}`], "draft and question only");
  assert.equal(opens().length, 0, "the open is queued, not sent");
  const q = (await store.get<any>("questions", "q1")) as any;
  assert.equal(q.rfi_id, RFI); assert.equal(q.status, "queued");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1); assert.equal(pending[0].status, "pending");
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

test("an approved open runs the transition with the designer, due date and message", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", QUESTION);
  await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(opens().length, 1);
  assert.equal(opens()[0].path, `${BASE}/rfis/${RFI}/transition`);
  assert.deepEqual(opens()[0].body, { to_state: "open", assignee_user_id: 42, due_date: "2026-11-15", message: "Please answer this RFI in Fieldwire." });
});

test("a question with no designer is parked with no calls", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S, fieldwire: { ...S.fieldwire!, designer_user_id: undefined } }, store, NOW, () => {});
  await store.put("questions", "q1", QUESTION);
  assert.deepEqual(await draft(ctx), { created: 1, queued: 0, needs_assignee: 1 });
  assert.equal(((await store.get<any>("questions", "q1")) as any).status, "needs-assignee");
  assert.equal(opens().length, 0);
});

test("ids from settings are checked before any call", async () => {
  const ctx = context(WF, { ...S, fieldwire: { ...S.fieldwire!, projects: ["not-a-uuid"] } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /bad id/);
  assert.equal(hits.length, 0);
});

test("one question with a bad due date is parked with its reason; the questions after it still run", async () => {
  const RFI2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", { ...QUESTION, due_date: "next week" });
  await store.put("questions", "q2", { ...QUESTION, id: "q2", rfi_id: RFI2, question_set: true });
  assert.deepEqual(await draft(ctx), { created: 1, queued: 1, needs_assignee: 1 });
  const q1 = (await store.get<any>("questions", "q1")) as any, q2 = (await store.get<any>("questions", "q2")) as any;
  assert.equal(q1.status, "needs-person");
  assert.match(q1.reason, /due must be a date/);
  assert.equal(q2.status, "queued");
  assert.equal(q1.rfi_id, RFI, "the RFI made for the bad question is kept, so a retry never makes a second one");
});

test("the approval shows the message Fieldwire will email, escaped", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("questions", "q1", { ...QUESTION, message: "Is it 2.4 m or 2.7 m <b>ceiling</b> & why?" });
  await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.match(ap.summary, /Message: "Is it 2\.4 m or 2\.7 m &lt;b&gt;ceiling&lt;\/b&gt; &amp; why\?"/);
});
