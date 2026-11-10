// Commission workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { figures, draftPay, queuePost } from "../industries/automotive/workflows/finance-admin/commission/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/automotive/workflows/finance-admin/commission/workflow.json", "utf8")) as WorkflowRecord;
const CAL = "00000000-0000-4000-8000-000000000001", RATE = "00000000-0000-4000-8000-000000000002";
const E1 = "00000000-0000-4000-8000-000000000003", E2 = "00000000-0000-4000-8000-000000000004";
const S1 = "10000000-0000-4000-8000-000000000003", S2 = "10000000-0000-4000-8000-000000000004";
const BASE = "20000000-0000-4000-8000-000000000001", RUN = "30000000-0000-4000-8000-000000000001";
const INV = (n: number) => `40000000-0000-4000-8000-00000000000${n}`;
const NOW = new Date("2026-11-02T01:00:00Z");
const S: any = {
  business_name: "Test Motors", payroll_calendar_id: CAL, commission_earnings_rate_id: RATE,
  tiers: [{ from: 0, rate: 0.03 }, { from: 50000, rate: 0.05 }],
  reps: [{ name: "Sam Lee", employee_id: E1, match: "SL-" }, { name: "Priya Nair", employee_id: E2, match: "PN-" }],
};

type Hit = { method: string; path: string; q: string; body: any };
let hits: Hit[] = [];
let runs: any[] = [];

const INVOICES: any[] = [
  { InvoiceID: INV(1), Status: "PAID", Type: "ACCREC", SubTotal: 40000, Reference: "SL-101 Ranger sale" },
  { InvoiceID: INV(2), Status: "PAID", Type: "ACCREC", SubTotal: 20000, Reference: "SL-102 service" },
  { InvoiceID: INV(3), Status: "PAID", Type: "ACCREC", SubTotal: 10000, Reference: "PN-201" },
  { InvoiceID: INV(4), Status: "PAID", Type: "ACCREC", SubTotal: 5000, Reference: "walk-in" },
  { InvoiceID: INV(5), Status: "AUTHORISED", Type: "ACCREC", SubTotal: 9999, Reference: "SL-103" },
];
let invoices: any[] = INVOICES;   // a test may change what Xero holds; beforeEach puts it back

function fake() {
  hits = []; runs = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, q: u.search, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Invoices")) return json({ Invoices: u.searchParams.get("page") === "1" ? invoices : [] });
      if (p.endsWith("/PayRuns") && m === "GET") return json({ PayRuns: runs });
      if (p.endsWith("/PayRuns") && m === "POST") {
        runs = [{ PayRunID: RUN, PayRunStatus: "DRAFT", PayrollCalendarID: CAL, PayRunPeriodStartDate: "2026-10-01T00:00:00", PayRunPeriodEndDate: "2026-10-31T00:00:00" }];
        return json({ PayRuns: runs });
      }
      if (p.endsWith(`/PayRuns/${RUN}`) && m === "GET") return json({ PayRuns: [{ ...runs[0], Payslips: [{ PayslipID: S1, EmployeeID: E1 }, { PayslipID: S2, EmployeeID: E2 }] }] });
      if (p.endsWith(`/PayRuns/${RUN}`) && m === "POST") { runs = [{ ...runs[0], PayRunStatus: "POSTED" }]; return json({ PayRuns: runs }); }
      if (p.endsWith(`/Payslip/${S1}`) && m === "GET") return json({ Payslip: { PayslipID: S1, EmployeeID: E1, EarningsLines: [{ EarningsRateID: BASE, CalculationType: "USEEARNINGSRATE", NumberOfUnits: 160, RatePerUnit: 30 }] } });
      if (p.endsWith(`/Payslip/${S2}`) && m === "GET") return json({ Payslip: { PayslipID: S2, EmployeeID: E2, EarningsLines: [{ EarningsRateID: BASE, CalculationType: "USEEARNINGSRATE", NumberOfUnits: 150, RatePerUnit: 30 }] } });
      if (p.includes("/Payslip/") && m === "POST") return json({ Payslips: [] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const posts = (path: string) => hits.filter((h) => h.method === "POST" && h.path.endsWith(path));

beforeEach(() => {
  fake(); invoices = INVOICES; setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a live operation cannot be drafted and a draft operation cannot be queued", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "payroll-au.updatePayRun", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.getInvoices", summary: "x" }), /not a live operation/);
});

test("figures: last month's paid sales become one commission row per rep, tiers applied, unpaid and unmatched sales left out", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await figures(ctx), { sales: 4, unmatched: 1, rows: 2 });
  const sam = await store.get<any>("commission", `2026-10:${E1.toLowerCase()}`);
  const priya = await store.get<any>("commission", `2026-10:${E2.toLowerCase()}`);
  assert.equal(sam.sales_ex_gst, 60000); assert.equal(sam.rate, 0.05); assert.equal(sam.amount, 3000);
  assert.equal(priya.sales_ex_gst, 10000); assert.equal(priya.amount, 300);
  assert.ok(hits.some((h) => decodeURIComponent(h.q.replace(/\+/g, " ")).includes("Date >= DateTime(2026,10,01) AND Date <= DateTime(2026,10,31)")), "reads October only");
  assert.equal(hits.filter((h) => h.method !== "GET" && !h.path.endsWith("/token")).length, 0, "figures writes nothing to Xero");
});

test("draft-pay: commission goes on each payslip in a DRAFT pay run, keeps the other lines, and a re-run writes nothing again", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await figures(ctx);
  assert.deepEqual(await draftPay(ctx), { entered: 2 });
  const created = posts("/PayRuns")[0];
  assert.equal(created.body[0].PayrollCalendarID, CAL);
  assert.deepEqual([created.body[0].PayRunPeriodStartDate, created.body[0].PayRunPeriodEndDate], ["2026-10-01", "2026-10-31"]);
  const sam = posts(`/Payslip/${S1}`)[0].body[0].EarningsLines;
  assert.deepEqual(sam.map((l: any) => l.EarningsRateID), [BASE, RATE], "the base line is kept");
  assert.equal(sam[1].RatePerUnit, 3000);
  assert.equal(posts(`/Payslip/${S2}`)[0].body[0].EarningsLines[1].RatePerUnit, 300);
  assert.equal(posts(`/PayRuns/${RUN}`).length, 0, "nothing is posted by a cron");
  assert.deepEqual(await draftPay(ctx), { entered: 0 });
  assert.equal(posts(`/Payslip/${S1}`).length, 1, "a re-run never writes the payslip twice");
});

test("queue-post: waits until every row is on the run, queues the post once, and the post only runs on approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await figures(ctx);
  assert.deepEqual(await queuePost(ctx), { queued: 0 }, "rows not yet entered");
  await draftPay(ctx);
  const first = await queuePost(ctx);
  assert.equal(first.queued, 1);
  await queuePost(ctx);
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1, "re-runs never queue twice");
  assert.deepEqual(approvals[0].acts.map((a) => [a.platform, a.op]), [["xero", "payroll-au.updatePayRun"]]);
  assert.deepEqual(approvals[0].acts[0].input, { params: { PayRunID: RUN }, body: [{ PayRunStatus: "POSTED" }] });
  assert.equal(posts(`/PayRuns/${RUN}`).length, 0, "queued, not posted");
  const ap = await approve(WF, store, approvals[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.deepEqual(posts(`/PayRuns/${RUN}`)[0].body, [{ PayRunStatus: "POSTED" }]);
  await assert.rejects(approve(WF, store, approvals[0].id, "owner"), /already done/);
});

test("figures: a sale whose reference matches two reps is counted as unmatched, never given to the first rep", async () => {
  invoices = [...INVOICES, { InvoiceID: INV(6), Status: "PAID", Type: "ACCREC", SubTotal: 7000, Reference: "SL-PN-300 joint" }];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await figures(ctx), { sales: 5, unmatched: 2, rows: 2 });
  assert.equal((await store.get<any>("commission", `2026-10:${E1.toLowerCase()}`))!.sales_ex_gst, 60000, "Sam keeps only his own sales");
  assert.equal((await store.get<any>("commission", `2026-10:${E2.toLowerCase()}`))!.sales_ex_gst, 10000);
});

test("settings: a match text under 3 characters stops the run before Xero is read", async () => {
  const short = { ...S, reps: [{ name: "Sam Lee", employee_id: E1, match: "S" }] };
  const ctx = context(WF, short, new MemoryStore(), NOW, () => {});
  await assert.rejects(figures(ctx), /needs a match text of 3 to 100 characters/);
  assert.equal(hits.filter((h) => h.method === "GET").length, 0, "nothing read from Xero");
});

test("once the pay post is queued, a rep whose row was none cannot be added to the run afterwards", async () => {
  const TOM = "00000000-0000-4000-8000-000000000005";
  const S3 = { ...S, reps: [...S.reps, { name: "Tom Bell", employee_id: TOM, match: "TB-" }] };
  const store = new MemoryStore(), ctx = context(WF, S3, store, NOW, () => {});
  await figures(ctx);
  assert.equal((await store.get<any>("commission", `2026-10:${TOM.toLowerCase()}`))!.status, "none");
  await draftPay(ctx);
  assert.equal((await queuePost(ctx)).queued, 1);
  invoices = [...INVOICES, { InvoiceID: INV(6), Status: "PAID", Type: "ACCREC", SubTotal: 8000, Reference: "TB-301" }];
  assert.deepEqual(await figures(ctx), { locked: true }, "figures stop once the post is queued");
  assert.equal((await store.get<any>("commission", `2026-10:${TOM.toLowerCase()}`))!.status, "none", "Tom's row is not recalculated");
  assert.deepEqual(await draftPay(ctx), { entered: 0, locked: true });
  assert.equal(posts(`/Payslip/${S1}`).length, 1, "no second payslip write");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "still one approval, the one the approver will see");
});
