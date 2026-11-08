// Fuel tax credits workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { purchases, ledger, claim } from "../industries/transport/workflows/finance-admin/fuel-tax-credits/index.ts";

const DIR = "industries/transport/workflows/finance-admin/fuel-tax-credits";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Transport", period_start: "2026-07-01", period_end: "2026-09-30",
  fuel_account_name: "Fuel tax credit", fuel_keywords: ["fuel", "diesel"] };
const NOW = new Date("2026-11-09T00:00:00Z");
const INV1 = "11111111-2222-4333-8444-555555555555", INV2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCT = "99999999-8888-4777-8666-555555555555";

type Hit = { method: string; path: string; query: string };
let hits: Hit[] = [];
let invoices: any[] = [];
let accounts: any[] = [];

function fake() {
  hits = [];
  invoices = [
    { InvoiceID: INV1, Type: "ACCPAY", Date: "2026-08-03T00:00:00", Contact: { Name: "Shell" },
      LineItems: [{ Description: "Diesel 200L", AccountCode: "310", LineAmount: 300 }, { Description: "Tyres", AccountCode: "320", LineAmount: 900 }] },
    { InvoiceID: INV2, Type: "ACCPAY", Date: "2026-09-10T00:00:00", Contact: { Name: "Ignore <script>" },
      LineItems: [{ Description: "Unleaded fuel card top up", AccountCode: "310", LineAmount: 150.5 }] },
  ];
  accounts = [{ UID: ACCT, Name: "Fuel tax credit", DisplayID: "1-1190", CurrentBalance: 1234.5 }, { UID: "cccccccc-dddd-4eee-8fff-000000000000", Name: "Bank", CurrentBalance: 5 }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      hits.push({ method: m, path: p, query: u.search });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: invoices });
      if (p.endsWith("/GeneralLedger/Account") && m === "GET") return json({ Items: accounts });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const writes = () => hits.filter((h) => h.method !== "GET" && !/token$/.test(h.path)); // the OAuth token refresh is not a business write

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { MYOB_ACCESS_TOKEN: "m", MYOB_API_KEY: "k", MYOB_COMPANY_FILE_ID: "cf-1",
    XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1" });
});

test("runtime: a cron cannot queue anything, and cannot draft a write", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "myob", op: "docs.post_cf_uri_GeneralLedger_GeneralJournal", summary: "x" }), /not a draft operation/);
});

test("purchases keeps only fuel lines in the period, and never writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await purchases(ctx), { found: 2, page_full: false });
  const kept = Object.values(await store.list<any>("fuel-bills")).map((b) => [b.invoice_id, b.amount_ex_gst]).sort();
  assert.deepEqual(kept, [[INV1, 300], [INV2, 150.5]]);
  const q = decodeURIComponent(hits.find((h) => h.path.endsWith("/Invoices"))!.query).replace(/\+/g, " ");
  assert.match(q, /Type=="ACCPAY" AND Date>=DateTime\(2026,7,1\) AND Date<=DateTime\(2026,9,30\)/);
  assert.match(q, /Statuses=AUTHORISED,PAID/);
  assert.equal(writes().length, 0, "no write reaches Xero");
});

test("a re-run overwrites the same bill lines, so nothing doubles", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await purchases(ctx); await purchases(ctx);
  assert.equal(Object.keys(await store.list("fuel-bills")).length, 2);
});

test("ledger finds the fuel tax credit account by name and reads no more than that", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await ledger(ctx), { found: true, balance: 1234.5 });
  assert.equal((await store.get<any>("fuel-account", "fuel-tax-credit")).uid, ACCT);
  assert.equal(writes().length, 0);
});

test("ledger reports a missing account rather than guessing one", async () => {
  accounts = [{ UID: "cccccccc-dddd-4eee-8fff-000000000000", Name: "Bank", CurrentBalance: 5 }];
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await ledger(ctx), { found: false });
});

test("claim waits for usage, then computes the eligible amount from litres and rate", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await purchases(ctx);
  const key = "2026-07-01_2026-09-30";
  assert.deepEqual(await claim(ctx).then((c) => [c.status, c.purchases_ex_gst, c.bills]), ["needs-usage", 450.5, 2]);
  await store.put("usage", key, { off_road_litres: 800, rate_per_litre: 0.2, source: "logbook export" });
  const ready = await claim(ctx);
  assert.equal(ready.status, "ready-for-review");
  assert.equal(ready.eligible, 160);
  assert.equal((await store.get<any>("claims", key))!.status, "ready-for-review");
});

test("claim refuses out-of-range usage", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("usage", "2026-07-01_2026-09-30", { off_road_litres: -5, rate_per_litre: 0.2, source: "typo" });
  assert.equal((await claim(ctx)).status, "invalid-usage");
});

test("bad period dates stop a cron before any network call", async () => {
  const ctx = context(WF, { ...SETTINGS, period_start: "1 July 2026" }, new MemoryStore(), NOW, () => {});
  await assert.rejects(purchases(ctx), /YYYY-MM-DD/);
  assert.equal(hits.length, 0);
});
