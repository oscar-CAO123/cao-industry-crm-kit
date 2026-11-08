// Agency ops board workflow tests. Every request goes to a fake network: no test reaches a real Productive account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, board, invoicing } from "../industries/agencies/workflows/finance-admin/ops/index.ts";
import { settingsOk, type Settings } from "../industries/agencies/workflows/finance-admin/ops/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/agencies/workflows/finance-admin/ops/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const S: Settings = {
  business_name: "Test Agency",
  productive: { ops_project_id: "10", task_list_id: "20", brief_deal_status_id: "9" },
  budget_warning_percent: 80,
};

type Hit = { method: string; path: string; raw: string; body: any };
let hits: Hit[] = [];
let failTask = 0;

function fake() {
  hits = []; failTask = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", raw = u.pathname;
      // Route on the vendor's path. The raw path is recorded too, so the guard test can see a doubled prefix.
      const p = raw.replace("/api/v2/api/v2", "/api/v2");
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, raw, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      if (p === "/api/v2/deals" && m === "GET") return json({ data: [
        { id: "501", type: "deals", attributes: { name: "Acme rebrand", deal_status_id: 9, company_id: 77 } },
        { id: "502", type: "deals", attributes: { name: "Old pitch", deal_status_id: 3, company_id: 78 } },
      ] });
      if (p === "/api/v2/tasks" && m === "POST") {
        if (failTask-- > 0) return new Response("{}", { status: 500 });
        return new Response(JSON.stringify({ data: { id: String(900 + hits.filter((h) => h.path === "/api/v2/tasks" && h.method === "POST").length), type: "tasks" } }), { status: 201, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (p === "/api/v2/reports/budget_reports" && m === "GET") return json({ data: [
        { id: "1", type: "budget_reports", attributes: { project_id: 40, budget_usage: 92, budgeted_time: 600, billable_time: 550 } },
        { id: "2", type: "budget_reports", attributes: { project_id: 41, budget_usage: 20, budgeted_time: 300, billable_time: 60 } },
      ] });
      if (p === "/api/v2/invoices" && m === "GET") return json({ data: [
        { id: "700", type: "invoices", attributes: { number: "INV-1", sent_on: null, delivery_on: "2026-11-08" } },
        { id: "701", type: "invoices", attributes: { number: "INV-2", sent_on: null, delivery_on: "2026-12-01" } },
        { id: "702", type: "invoices", attributes: { number: "INV-3", sent_on: "2026-11-01", delivery_on: "2026-11-01" } },
      ] });
      if (p === "/api/v2/invoices/700" && m === "PATCH") return json({ data: { id: "700", type: "invoices", attributes: { sent_on: "2026-11-08" } } });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const taskPosts = () => hits.filter((h) => h.method === "POST" && h.path === "/api/v2/tasks");
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PRODUCTIVE_API_TOKEN: "pt", PRODUCTIVE_ORGANIZATION_ID: "1", KIT_ALLOW_WRITES: "1" });
});

test("guard: requests go to Productive's real paths, not a doubled /api/v2 prefix", async () => {
  // core/sdk/call.ts joins Productive's server base path and op path once (fixed 9 Nov 2026).
  await intake(context(WF, S, new MemoryStore(), NOW, () => {}));
  for (const h of hits) assert.ok(!h.raw.includes("/api/v2/api/v2"), `doubled prefix in ${h.raw}`);
});

test("settings: numeric ids only, refused before any call", () => {
  assert.throws(() => settingsOk({ ...S, productive: { ...S.productive, ops_project_id: "10; drop" } }), /numeric/);
  assert.throws(() => settingsOk({ ...S, budget_warning_percent: 0 }), /between 0 and 100/);
  assert.equal(settingsOk(S), S);
});

test("crons never send: intake and board only draft internal tasks, invoicing queues and sends nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await intake(context(WF, S, store, NOW, () => {})), { added: 1, failed: 0 });
  assert.equal(taskPosts().length, 1, "one scoping task for the brief deal, not for the other deal");
  assert.equal(taskPosts()[0].body.data.relationships.project.data.id, "10");
  assert.equal(taskPosts()[0].body.data.relationships.task_list.data.id, "20");
  assert.deepEqual(await board(context(WF, S, store, NOW, () => {})), { flagged: 1, failed: 0 });
  assert.equal(taskPosts().length, 2, "one budget task for project 40 only");
  assert.deepEqual(await invoicing(context(WF, S, store, NOW, () => {})), { queued: 1 });
  assert.equal(writes().filter((h) => h.path.startsWith("/api/v2/invoices")).length, 0, "invoicing did not PATCH anything");
  assert.equal(writes().length, 2, "only the two internal task creates were written");
});

test("a live op is only queued; approval runs it with the invoice id and the sent date", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await invoicing(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["invoices-update"]);
  assert.match(ap.summary, /INV-1/);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const patch = hits.find((h) => h.method === "PATCH")!;
  assert.equal(patch.path, "/api/v2/invoices/700");
  assert.deepEqual(patch.body, { data: { type: "invoices", id: "700", attributes: { sent_on: "2026-11-08" } } });
  assert.equal(hits.filter((h) => h.method === "PATCH").length, 1, "the invoice not yet due was never touched");
});

test("re-runs never double-queue or double-create: each deal, budget and invoice acts once", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await intake(context(WF, S, store, NOW, () => {}));
  await board(context(WF, S, store, NOW, () => {}));
  await board(context(WF, S, store, NOW, () => {}));
  assert.equal(taskPosts().length, 2, "no second scoping task, no second budget task this month");
  await invoicing(context(WF, S, store, NOW, () => {}));
  await invoicing(context(WF, S, store, NOW, () => {}));
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "invoicing queued once");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  await invoicing(context(WF, S, store, NOW, () => {}));
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "an approved invoice is not queued again");
  assert.equal(hits.filter((h) => h.method === "PATCH").length, 1);
});

test("a failed task is counted, not stored, and retried on the next run", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  failTask = 1;
  assert.deepEqual(await intake(ctx), { added: 0, failed: 1 });
  assert.equal(await store.get("briefs", "501"), undefined);
  assert.deepEqual(await intake(context(WF, S, store, NOW, () => {})), { added: 1, failed: 0 });
});

test("a draft operation cannot be the live invoice write, and a live one cannot be drafted", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "productive", op: "invoices-update", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "productive", op: "tasks-create", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});
