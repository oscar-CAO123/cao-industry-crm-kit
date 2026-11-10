// Labour-by-person workflow, Procore hours source. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import * as wf from "../industries/construction/workflows/finance-admin/x-labour/index.ts";

const DIR = "industries/construction/workflows/finance-admin/x-labour";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const CAL = "11111111-2222-4333-8444-555555555555", RATE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EMP_A = "20000000-0000-4000-8000-00000000000a", EMP_B = "20000000-0000-4000-8000-00000000000b";
const NOW = new Date("2026-11-08T00:00:00Z");
const S: any = {
  pay_period: { start: "2026-11-02", end: "2026-11-15", payment_date: "2026-11-20" }, payroll_calendar_id: CAL,
  employee_map: { "701": EMP_A, "702": EMP_B }, earnings_rate_id: RATE, max_hours_per_shift: 12, procore: { mirror_status: "approved" },
};
const gid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = (id: number, date: string, hours: string, status = "approved", extra: object = {}) => ({ id, date, hours, deleted_at: null, timesheet_status: { status }, ...extra });

type Hit = { method: string; path: string; query: URLSearchParams; body: any; headers: Headers };
let hits: Hit[] = [];
// Pages of people for the Procore list, by page number (1-based). An empty list ends paging.
let pages: any[][] = [];
let xts: Record<string, { timesheetID: string; employeeID: string; status: string; totalHours: number; lines: any[] }> = {};
let seq = 0;

/** Person 701 has an 8 and a 4 hour approved entry, a pending one and a deleted one; 702 has one 14 hour entry (held over the limit); 703 has no Xero employee. */
function week(): any[][] {
  return [[
    { party: { id: 701, name: "A Worker" }, timecard_entries: [entry(1, "2026-11-02", "8.0"), entry(2, "2026-11-03", "4.0"), entry(3, "2026-11-04", "6.0", "pending"), entry(4, "2026-11-05", "5.0", "approved", { deleted_at: "2026-11-06T00:00:00Z" })] },
    { party: { id: 702, name: "B Worker" }, timecard_entries: [entry(5, "2026-11-02", "14.0")] },
    { party: { id: 703, name: "C Worker" }, timecard_entries: [entry(6, "2026-11-02", "7.5")] },
  ]];
}

function fake() {
  hits = []; seq = 0; xts = {}; pages = week();
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body, headers: new Headers(init?.headers) });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.hostname === "api.procore.com") {
        if (p === "/rest/v1.0/companies/777/timesheets" && m === "GET") return json(pages[Number(u.searchParams.get("page") ?? 1) - 1] ?? []);
        return new Response("not faked: " + p, { status: 404 });
      }
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Timesheets") && m === "GET") {
        const status = u.searchParams.get("status");
        const rows = Object.values(xts).filter((t) => !status || t.status === status).map((t) => ({ timesheetID: t.timesheetID, employeeID: t.employeeID, status: t.status, totalHours: t.totalHours }));
        return json({ timesheets: rows, pagination: { pageCount: 1 } });
      }
      if (p.endsWith("/Timesheets") && m === "POST") {
        const id = gid(++seq), lines = body.timesheetLines ?? [];
        xts[id] = { timesheetID: id, employeeID: body.employeeID, status: "Draft", totalHours: lines.reduce((a: number, l: any) => a + Number(l.numberOfUnits), 0), lines: [...lines] };
        return json({ timesheet: { timesheetID: id, status: "Draft" } });
      }
      const lines = p.match(/\/Timesheets\/([^/]+)\/Lines$/);
      if (lines && m === "POST") {
        const t = xts[lines[1]];
        if (!t) return new Response("{}", { status: 404 });
        t.lines.push(body); t.totalHours += Number(body.numberOfUnits);
        return json({ timesheetLine: { timesheetLineID: gid(++seq) } });
      }
      const one = p.match(/\/Timesheets\/([^/]+)$/);
      if (one && m === "GET") { const t = xts[one[1]]; return t ? json({ timesheet: { timesheetID: t.timesheetID, employeeID: t.employeeID, status: t.status, totalHours: t.totalHours } }) : new Response("{}", { status: 404 }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const procoreHits = () => hits.filter((h) => h.path.includes("/companies/"));
const xeroWrites = () => hits.filter((h) => h.method === "POST" && h.path.includes("/Timesheets"));
const ctxFor = (store: MemoryStore, settings: any = S) => context(WF, settings, store, NOW, () => {});

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PROCORE_ACCESS_TOKEN: "pc-token", PROCORE_COMPANY_ID: "777", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("mirror reads Procore timecards read-only, and only approved, undeleted hours reach a Xero draft", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  const r = await wf.mirror(ctx) as any;
  assert.deepEqual(r, { mirrored: 2, flagged: 1, unmapped: 1, failed: 0, held: 1 }, "701's two approved entries mirror; 702's 14 hours are held; 703 has no Xero employee");
  const g = procoreHits()[0];
  assert.equal(g.method, "GET"); assert.equal(g.path, "/rest/v1.0/companies/777/timesheets", "the company id is the pinned one");
  assert.equal(g.query.get("start_date"), "2026-11-02"); assert.equal(g.query.get("end_date"), "2026-11-15");
  assert.equal(g.query.get("skip_saving_sticky_filters"), "true", "a background read never changes anyone's saved filters");
  assert.equal(g.headers.get("procore-company-id"), "777"); assert.equal(g.headers.get("authorization"), "Bearer pc-token");
  assert.ok(procoreHits().every((h) => h.method === "GET"), "nothing is written to Procore");
  const sheet = Object.values(xts).find((t) => t.employeeID === EMP_A)!;
  assert.equal(sheet.totalHours, 12, "8 + 4; the pending 6 and the deleted 5 are left out");
  assert.equal(Object.values(xts).length, 1, "only 701 reached Xero");
  assert.equal(Object.values(xts).some((t) => t.employeeID === EMP_B), false, "the 14 hour entry is held, not written");
  assert.equal(xeroWrites().length, 2, "701: one timesheet create carrying the first entry, then one line for the second");
});

test("a rerun writes nothing new to Xero", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  const before = xeroWrites().length;
  const r = await wf.mirror(ctx) as any;
  assert.equal(r.mirrored, 0);
  assert.equal(xeroWrites().length, before);
});

test("paging runs to an empty page and a period with too many pages is refused whole", async () => {
  pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [entry(11, "2026-11-02", "8.0")] }], [{ party: { id: 701, name: "A" }, timecard_entries: [entry(12, "2026-11-03", "4.0")] }], []];
  const store = new MemoryStore();
  assert.equal(((await wf.mirror(ctxFor(store))) as any).mirrored, 2);
  assert.deepEqual(procoreHits().map((h) => h.query.get("page")), ["1", "2", "3"], "stops at the empty page");
  fake(); // fresh transport and hits
  pages = Array.from({ length: 30 }, (_, n) => [{ party: { id: 701, name: "A" }, timecard_entries: [entry(100 + n, "2026-11-02", "1.0")] }]);
  await assert.rejects(wf.mirror(ctxFor(new MemoryStore())), /longer than 20 pages; refused whole/);
  assert.equal(procoreHits().length, 20);
  assert.equal(xeroWrites().length, 0, "a refused period writes nothing");
});

test("a row that does not check out holds every mapped person and writes nothing", async () => {
  pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [entry(1, "2026-11-02", "8.0"), entry(2, "2026-11-03", "lots")] }]];
  const store = new MemoryStore();
  const r = await wf.mirror(ctxFor(store)) as any;
  assert.deepEqual(r, { blocked: 1 });
  assert.equal(xeroWrites().length, 0);
  for (const bad of [entry(3, "not-a-date", "8.0"), entry(4, "2026-11-02", "25"), entry(5, "2026-11-02", "-1"), { id: "x", date: "2026-11-02", hours: "1", timesheet_status: { status: "approved" } }]) {
    fake(); pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [bad] }]];
    assert.deepEqual(await wf.mirror(ctxFor(new MemoryStore())), { blocked: 1 }, JSON.stringify(bad));
  }
});

test("the status is read from approval_status when the entry has one, and from the deprecated timesheet_status otherwise", async () => {
  pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [
    { id: 31, date: "2026-11-02", hours: "2.0", deleted_at: null, approval_status: "approved", timesheet_status: { status: "pending" } },
    { id: 32, date: "2026-11-03", hours: "3.0", deleted_at: null, approval_status: "pending", timesheet_status: { status: "approved" } },
    { id: 33, date: "2026-11-04", hours: "4.0", deleted_at: null, timesheet_status: { status: "approved" } }] }]];
  await wf.mirror(ctxFor(new MemoryStore()));
  assert.equal(Object.values(xts)[0].totalHours, 6, "entry 31 (approval_status approved) and 33 (only the old field says approved); 32 is pending");
});

test("a mirror_status that is not one of Procore's documented words is refused before any call", async () => {
  await assert.rejects(wf.mirror(ctxFor(new MemoryStore(), { ...S, procore: { mirror_status: "paid" } })), /must be one of pending, reviewed, approved, completed, rejected/);
  assert.equal(hits.length, 0);
});

test("missing hours (null, empty, absent) hold everyone; they are not read as zero", async () => {
  for (const hours of [null, "", undefined]) {
    fake(); pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [{ id: 41, date: "2026-11-02", hours, deleted_at: null, timesheet_status: { status: "approved" } }] }]];
    assert.deepEqual(await wf.mirror(ctxFor(new MemoryStore())), { blocked: 1 }, String(hours));
  }
});

test("the same entry id on two pages is counted once", async () => {
  const e = entry(51, "2026-11-02", "8.0");
  pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [e] }], [{ party: { id: 701, name: "A" }, timecard_entries: [e] }], []];
  await wf.mirror(ctxFor(new MemoryStore()));
  assert.equal(Object.values(xts)[0].totalHours, 8);
});

test("an entry mirrored and then reverted, deleted or edited in Procore holds that person from approval", async () => {
  for (const change of ["revert", "delete", "edit"]) {
    fake(); pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [entry(61, "2026-11-02", "8.0")] }]];
    const store = new MemoryStore();
    await wf.mirror(ctxFor(store));
    const first = Object.values(xts)[0].timesheetID;
    pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [change === "revert" ? entry(61, "2026-11-02", "8.0", "pending") : change === "delete" ? entry(61, "2026-11-02", "8.0", "approved", { deleted_at: "2026-11-06T00:00:00Z" }) : entry(61, "2026-11-02", "9.0")] }]];
    const r = await wf.mirror(ctxFor(store)) as any;
    assert.equal(r.held, 1, change);
    const holds = (await store.get<any>("timesheet-holds", Object.keys(await store.list("timesheet-holds"))[0])) as any;
    assert.deepEqual(holds.employees, [EMP_A], `${change}: the person is held from approval`);
    assert.ok(first);
  }
});

test("without procore.mirror_status the run stops before any call", async () => {
  await assert.rejects(wf.mirror(ctxFor(new MemoryStore(), { ...S, procore: {} })), /set procore.mirror_status/);
  assert.equal(hits.length, 0);
});

test("a 200 that is not a list fails the run and writes nothing", async () => {
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async () => new Response(JSON.stringify({ errors: "rate limited" }), { status: 200, headers: { "content-type": "application/json" } })) as any });
  await assert.rejects(wf.mirror(ctxFor(new MemoryStore())), /did not come back as a list/);
});

test("entries outside the pay period are left out", async () => {
  pages = [[{ party: { id: 701, name: "A" }, timecard_entries: [entry(21, "2026-11-01", "8.0"), entry(22, "2026-11-16", "8.0"), entry(23, "2026-11-10", "3.0")] }]];
  await wf.mirror(ctxFor(new MemoryStore()));
  assert.equal(Object.values(xts)[0].totalHours, 3);
});
