// Job budgets workflow tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/agencies/workflows/finance-admin/x-jobbudgets/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/agencies/workflows/finance-admin/x-jobbudgets/workflow.json", "utf8")) as WorkflowRecord;
const SETTINGS: any = { family: "job-budgets", overrun_pct: 90 };
const NOW = new Date("2026-11-09T00:00:00Z");
let hits: { method: string; path: string }[] = [];

const PROJECTS = [
  { projectId: "11111111-2222-4333-8444-555555555555", name: "Brand refresh", status: "INPROGRESS", estimateAmount: 10000, totalTaskAmount: 9600, totalExpenseAmount: 200, minutesLogged: 4200 },
  { projectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Website build", status: "INPROGRESS", estimateAmount: 20000, totalTaskAmount: 5000, totalExpenseAmount: 0, minutesLogged: 1800 },
  { projectId: "99999999-8888-4777-8666-555555555555", name: "No estimate", status: "INPROGRESS", estimateAmount: null, totalTaskAmount: 300, totalExpenseAmount: 0, minutesLogged: 60 },
];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      hits.push({ method: m, path: p });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Projects") && m === "GET") return json({ items: PROJECTS, pagination: { page: 1 } });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("burn: snapshots every job and makes no write to Xero", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await CRONS.burn(ctx), { jobs: 3 });
  const rows = await store.list<any>("burn");
  assert.equal(Object.keys(rows).length, 3);
  const brand = Object.values(rows).find((r: any) => r.name === "Brand refresh") as any;
  assert.equal(brand.spent, 9800, "task plus expense totals");
  assert.equal(brand.estimate, 10000);
  assert.equal(hits.filter((h) => h.method !== "GET" && !/token$/.test(h.path)).length, 0, "no non-GET call to Xero");
});

test("overrun: flags a job at 98 percent, not one at 25, and skips a job with no estimate", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await CRONS.overrun(ctx), { flagged: 1 });
  const flagged = await store.list<any>("overruns");
  assert.deepEqual(Object.values(flagged).map((r: any) => r.name), ["Brand refresh"]);
  assert.equal((Object.values(flagged)[0] as any).over, false);
});

test("re-running a cron overwrites its snapshot and never double-counts a flag", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await CRONS.overrun(ctx); await CRONS.overrun(ctx); await CRONS.burn(ctx); await CRONS.burn(ctx);
  assert.equal(Object.keys(await store.list("overruns")).length, 1);
  assert.equal(Object.keys(await store.list("burn")).length, 3);
});

test("the runtime refuses any Xero write as a draft, and queues nothing because no live op is mapped", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "projects.createProject", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "projects.createTimeEntry", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "projects.createProject", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});
