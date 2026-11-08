// Missed rebates workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { pull, flag } from "../industries/health-care/workflows/finance-admin/rebates/index.ts";
import { clinikoId } from "../industries/health-care/workflows/finance-admin/rebates/adapters/cliniko.ts";
import { render, TARGETS } from "../tools/deploy.ts";
import fs from "node:fs";

const DIR = "industries/health-care/workflows/finance-admin/rebates";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SET: any = { business_name: "Test Clinic", rebate_codes: ["MBS-23"], review_after_days: 14 };
const NOW = new Date("2026-11-09T00:00:00Z");
const OLD = "2026-10-01T00:00:00Z";     // more than 14 days before NOW
const RECENT = "2026-11-05T00:00:00Z";  // inside the review window

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let invoices: any[] = [];
let itemsFor: Record<string, any[]> = {};
let payRows: any[] = [];

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
      // Cliniko
      if (p.endsWith("/invoices") && m === "GET") return json({ invoices });
      const items = /\/invoices\/(\d+)\/invoice_items$/.exec(p);
      if (items && m === "GET") return json({ invoice_items: itemsFor[items[1]] ?? [] });
      // Xero
      if (p.endsWith("/Payments") && m === "GET") return json({ Payments: payRows });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
// The only non-GET request allowed is the OAuth token refresh (Xero's /connect/token), which is not a platform write.
const writes = () => hits.filter((h) => h.method !== "GET" && !/token$/.test(h.path));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { CLINIKO_API_KEY: "k", CLINIKO_USER_AGENT: "kit-test", CLINIKO_SHARD: "au1",
    XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1" });
  invoices = [
    { id: "101", number: 1, status: 10, total_amount: "80.00", created_at: OLD },     // open, rebate item, old, unpaid: flag
    { id: "102", number: 2, status: 20, total_amount: "80.00", created_at: OLD },     // paid in Cliniko: never flag
    { id: "103", number: 3, status: 10, total_amount: "60.00", created_at: RECENT },  // inside the window: never flag
  ];
  itemsFor = {
    "101": [{ code: "MBS-23", quantity: "1", unit_price: "80.00" }],
    "102": [{ code: "MBS-23", quantity: "1", unit_price: "80.00" }],
    "103": [{ code: "OTHER", quantity: "1", unit_price: "60.00" }],
  };
  payRows = [{ Invoice: { InvoiceNumber: "2" }, Amount: 80, Date: "/Date(1767225600000)/", Status: "AUTHORISED" }];
});

test("pull reads Cliniko and Xero and sends nothing: every request is a GET", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await pull(context(WF, SET, store, NOW, () => {})), { invoices_seen: 3, item_reads: 3, payments: 1 });
  assert.deepEqual(writes().map((h) => h.path), [], "no write reached any platform");
  const rows = await store.list<any>("invoices");
  assert.deepEqual(Object.keys(rows).sort(), ["cliniko:101", "cliniko:102", "cliniko:103"]);
  assert.deepEqual(Object.keys(rows["cliniko:101"]).sort(), ["codes", "created_at", "id", "key", "number", "status", "total_amount"], "no patient details kept");
  // A second run reuses the item codes it already has, so it reads no items again.
  assert.deepEqual(await pull(context(WF, SET, store, NOW, () => {})), { invoices_seen: 3, item_reads: 0, payments: 1 });
});

test("flag lists only the open, old, rebate-item invoice with no Xero payment, once", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SET, store, NOW, () => {}));
  assert.deepEqual(await flag(context(WF, SET, store, NOW, () => {})), { flagged: 1 });
  const flags = await store.list<any>("flags");
  assert.deepEqual(Object.keys(flags), ["flag:cliniko:101"]);
  assert.equal(flags["flag:cliniko:101"].status, "to-check");
  assert.match(flags["flag:cliniko:101"].reason, /Check the claim in Cliniko/);
  assert.deepEqual(await flag(context(WF, SET, store, NOW, () => {})), { flagged: 0 }, "a re-run never lists it twice");
  assert.equal(writes().length, 0);
});

test("flag skips an invoice that Xero shows as paid", async () => {
  const store = new MemoryStore();
  payRows = [{ Invoice: { InvoiceNumber: "1" }, Amount: 80, Date: "/Date(1767225600000)/", Status: "AUTHORISED" }];
  await pull(context(WF, SET, store, NOW, () => {}));
  assert.deepEqual(await flag(context(WF, SET, store, NOW, () => {})), { flagged: 0 });
});

test("flag does nothing until rebate codes are set", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SET, store, NOW, () => {}));
  assert.deepEqual(await flag(context(WF, { ...SET, rebate_codes: [] }, store, NOW, () => {})), { flagged: 0, reason: "no rebate codes set in settings" });
});

test("runtime: a cron cannot run a write, and cannot queue anything (no live operation is mapped)", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "cliniko", op: "invoice.getinvoice", summary: "x", input: { params: { id: "1" } } }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.emailInvoice", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("ids from outside are checked before they reach a path", () => {
  assert.equal(clinikoId("101"), "101");
  assert.throws(() => clinikoId("101/../../x"), /bad id/);
});

test("deploy: every target renders both crons, with no key values", () => {
  for (const t of TARGETS) {
    const all = Object.values(render(DIR, SET, t)).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    assert.ok(!/Bearer [A-Za-z0-9]{8}|k-test|kit-test/.test(all), `${t} carries no key values`);
  }
});
