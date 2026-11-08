// Numbers pack tests. Every request goes to a fake network: no test reaches a real ledger.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { dataPull, cashCheck, packBuild } from "../industries/all/workflows/finance-admin/numbers-pack/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/finance-admin/numbers-pack/workflow.json", "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Events", ledger: "xero", cadence: "monthly" };
const LAST_DAY = new Date("2026-10-31T22:00:00Z");   // last day of October (UTC): the monthly pack is due
const MID = new Date("2026-11-03T22:00:00Z");         // not due
const SUNDAY = new Date("2026-11-08T22:00:00Z");      // a Sunday (UTC): the weekly pack would be due
const EVIL = "<img src=x onerror=alert(1)>Sales";

type Hit = { method: string; path: string; search: string };
let hits: Hit[] = [];
const REPORT = (label: string) => ({
  Reports: [{ ReportTitles: ["Profit and Loss"], Rows: [
    { RowType: "Header", Cells: [{ Value: "" }, { Value: "1 Oct 26" }, { Value: "31 Oct 26" }] },
    { RowType: "Section", Title: "Income", Rows: [{ RowType: "Row", Cells: [{ Value: label }, { Value: "1000.00" }, { Value: "2000.00" }] }] },
    { RowType: "SummaryRow", Cells: [{ Value: "Net Profit" }, { Value: "500.00" }, { Value: "900.00" }] },
  ] }],
});
const BANK = { Reports: [{ Rows: [
  { RowType: "Header", Cells: [{ Value: "" }, { Value: "Money in" }, { Value: "Closing" }] },
  { RowType: "Section", Title: "Bank", Rows: [{ RowType: "Row", Cells: [{ Value: "Operating account" }, { Value: "300.00" }, { Value: "4200.50" }] }] },
] }] };

function fake(opts: { label?: string } = {}) {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      hits.push({ method: m, path: p, search: u.search });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Reports/ProfitAndLoss")) return json(REPORT(opts.label ?? EVIL));
      if (p.endsWith("/Reports/BankSummary")) return json(BANK);
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
// The OAuth refresh is a POST to the sign-in endpoint, not a change in the ledger.
const writes = () => hits.filter((h) => h.method !== "GET" && !/\/connect\/token$/.test(h.path));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1" });
  delete process.env.KIT_ALLOW_WRITES;
});

test("runtime: a cron cannot run a live operation, and a numbers pack queues nothing", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), LAST_DAY, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a live operation/);
  assert.deepEqual(WF.live_ops, {});
});

test("crons never send: every request they make is a read", async () => {
  const store = new MemoryStore();
  const log = () => {};
  await dataPull(context(WF, SETTINGS, store, LAST_DAY, log));
  await cashCheck(context(WF, SETTINGS, store, LAST_DAY, log));
  await packBuild(context(WF, SETTINGS, store, LAST_DAY, log));
  assert.ok(hits.length >= 3, "the crons should have read the ledger");
  assert.deepEqual(writes(), []);
  assert.ok(hits.every((h) => /\/Reports\/(ProfitAndLoss|BankSummary)$|\/token$|\/connections$/.test(h.path)), JSON.stringify(hits));
});

test("data-pull stores the profit and loss on the due day and not otherwise", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await dataPull(context(WF, SETTINGS, store, MID, () => {})), { skipped: "period not due" });
  assert.equal(hits.length, 0, "nothing is read on a day that is not due");
  const r: any = await dataPull(context(WF, SETTINGS, store, LAST_DAY, () => {}));
  assert.equal(r.stored, "2026-10-01_2026-10-31");
  const snap: any = await store.get("snapshots", r.stored);
  assert.equal(snap.kind, "profit-and-loss");
  assert.deepEqual(snap.columns, ["", "1 Oct 26", "31 Oct 26"]);
  assert.equal(snap.rows.length, 3);
  assert.equal(snap.rows[1].label, EVIL);          // stored as the platform sent it; escaping happens in the pack
});

test("re-running a due day overwrites the same period, never adds a second one", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, LAST_DAY, () => {});
  await dataPull(ctx()); await dataPull(ctx());
  await cashCheck(context(WF, SETTINGS, store, LAST_DAY, () => {})); await cashCheck(context(WF, SETTINGS, store, LAST_DAY, () => {}));
  await packBuild(ctx()); await packBuild(ctx());
  assert.equal(Object.keys(await store.list("snapshots")).length, 1);
  assert.equal(Object.keys(await store.list("bank")).length, 1);
  assert.equal(Object.keys(await store.list("packs")).length, 1);
});

test("pack-build drafts an escaped pack from the stored snapshots and never sends", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await packBuild(context(WF, SETTINGS, store, LAST_DAY, () => {})), { skipped: "no profit and loss snapshot for this period yet" });
  await dataPull(context(WF, SETTINGS, store, LAST_DAY, () => {}));
  await cashCheck(context(WF, SETTINGS, store, LAST_DAY, () => {}));
  const r: any = await packBuild(context(WF, SETTINGS, store, LAST_DAY, () => {}));
  assert.equal(r.drafted, "2026-10-01_2026-10-31");
  assert.equal(r.bank, true);
  const pack: any = await store.get("packs", r.drafted);
  assert.equal(pack.status, "draft");
  assert.ok(!pack.html.includes("<img src=x"), "a label from the ledger must be escaped");
  assert.ok(pack.html.includes("&lt;img src=x"));
  assert.ok(pack.html.includes("Operating account"));
  assert.ok(pack.html.includes("Not written yet"), "commentary stays for the owner");
  assert.deepEqual(writes(), []);
});

test("an unmapped ledger fails before any read", async () => {
  await assert.rejects(dataPull(context(WF, { ...SETTINGS, ledger: "myob" }, new MemoryStore(), LAST_DAY, () => {})), /has no adapter yet/);
  assert.equal(hits.length, 0);
});
