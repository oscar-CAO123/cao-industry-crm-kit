// Market-forecasting workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { demandSignal, priceWatch, forecast, summaryHtml } from "../industries/agriculture-mining/workflows/sales/market-forecasting/index.ts";
import fs from "node:fs";

const DIR = "industries/agriculture-mining/workflows/sales/market-forecasting";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-12-02T00:00:00Z");

const INV_GARLIC = "11111111-2222-4333-8444-555555555555", INV_NOV = "22222222-3333-4444-8555-666666666666", INV_DRAFT = "33333333-4444-4555-8666-777777777777";
const INVOICES = [
  { InvoiceID: INV_GARLIC, Status: "AUTHORISED", Date: "2026-10-05T00:00:00", Contact: { Name: "Riverbend Buyers" },
    LineItems: [{ ItemCode: "GARLIC-10", Description: "Garlic 10kg", Quantity: 10, UnitAmount: 100 }, { ItemCode: "POTATO-20", Description: "Potato 20kg", Quantity: 4, UnitAmount: 50 }] },
  { InvoiceID: INV_NOV, Status: "PAID", Date: "2026-11-03T00:00:00", Contact: { Name: "Riverbend Buyers" },
    LineItems: [{ ItemCode: "GARLIC-10", Description: "Garlic 10kg", Quantity: 20, UnitAmount: 110 }] },
  { InvoiceID: INV_DRAFT, Status: "DRAFT", Date: "2026-11-04T00:00:00", Contact: { Name: "Nobody" },
    LineItems: [{ ItemCode: "POTATO-20", Description: "Potato 20kg", Quantity: 999, UnitAmount: 1 }] },
];
const ITEMS = [
  { Code: "GARLIC-10", Name: "Garlic 10kg", SalesDetails: { UnitPrice: 115 } },
  { Code: "POTATO-20", Name: "Potato 20kg", SalesDetails: { UnitPrice: 60 } },
];
const ENQUIRY = { id: "AAMkEnq1", subject: "Order enquiry: garlic", from: { emailAddress: { name: "Buyer", address: "buyer@example.com" } },
  receivedDateTime: "2026-11-30T01:00:00Z", bodyPreview: "Could use five pallets of garlic next month" };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: INVOICES });
      if (p.endsWith("/Items") && m === "GET") return json({ Items: ITEMS });
      if (/\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: "AAMkDraft9" });
      if (p.endsWith("/messages")) return json({ value: [ENQUIRY] });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path) || (h.method === "POST" && h.path.includes("/Invoices")));
/** Register rows written this run, matched by their last cell (the note). */
const registerRows = (note: string) => hits
  .filter((h) => h.path.endsWith("/rows") && h.method === "POST")
  .flatMap((h) => (h.body?.values ?? []) as unknown[][])
  .filter((row) => row[row.length - 1] === note);

const S: any = {
  business_name: "Test Packing", summary_to: "owner@example.com",
  microsoft_365: { mailbox: "owner@example.com", search: "order", register: { drive: "DRIVE1", item: "ITEM1", table: "Forecasts" } },
  forecast_months: 3, price_alert_percent: 5,
};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot queue a draft operation and cannot draft a live one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a draft operation/);
});

test("demand signal reads only: sale lines from authorised and paid invoices (drafts skipped), enquiries stored, nothing sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await demandSignal(ctx), { sale_lines: 3, enquiries: 1 });
  const lines = Object.values(await store.list<any>("sales"));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.qty !== 999), "the draft invoice is not a sale");
  assert.equal(sends().length, 0);
  assert.equal(hits.filter((h) => h.method !== "GET" && !h.path.endsWith("/token")).length, 0, "no write from a read cron");
  const [enq] = Object.values(await store.list<any>("enquiries"));
  assert.deepEqual(Object.keys(enq).sort(), ["id", "received", "title"], "only the subject and time are kept: no sender address, no body preview");
});

test("price watch: a move past the alert level is logged to the register once a month, and not again on a re-run", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await demandSignal(ctx);
  assert.deepEqual(await priceWatch(ctx), { checked: 2, logged: 1 });
  assert.deepEqual(registerRows("list price differs from last invoiced"), [["2026-12-02", "POTATO-20", "Potato 20kg", 50, 60, 20, "list price differs from last invoiced"]]);
  assert.deepEqual(await priceWatch(ctx), { checked: 2, logged: 0 }, "re-runs never log the same move twice");
  assert.equal(sends().length, 0);
});

test("forecast: expected volume from the trailing average, one register row per item, one summary draft, one queued send, approval sends it", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await demandSignal(ctx); await priceWatch(ctx);
  assert.deepEqual(await forecast(ctx), { forecast_rows: 2, drafted: true, price_moves: 1 });

  assert.deepEqual(registerRows("forecast for 2026-12").map((r) => [r[1], r[3]]), [["GARLIC-10", 10], ["POTATO-20", 1.3]]);

  const drafts = hits.filter((h) => h.path.endsWith("/messages") && h.method === "POST");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].body.toRecipients[0].emailAddress.address, "owner@example.com");
  assert.match(drafts[0].body.body.content, /Price moves to check/);
  assert.equal(sends().length, 0, "nothing sent by a cron");

  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["users.user.messages.message.send"]);

  assert.deepEqual(await forecast(ctx), { forecast_rows: 2, drafted: false }, "a re-run drafts nothing new");
  assert.equal(hits.filter((h) => h.path.endsWith("/messages") && h.method === "POST").length, 1);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "a re-run queues nothing new");
  assert.equal(registerRows("forecast for 2026-12").length, 2, "a re-run writes no register rows");

  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1, "the summary went once, after approval");
});

test("the summary escapes item names and never carries raw markup", () => {
  const html = summaryHtml(S, "2026-12", 3, [{ name: "<img src=x onerror=1>", expected: 2 }], [], 0);
  assert.ok(!html.includes("<img"), "no raw tag from an item name");
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;"));
});
