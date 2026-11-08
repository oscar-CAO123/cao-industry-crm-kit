// Comp and discount watch tests. Every request goes to a fake network: no test reaches a real Square account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { watch, report, venues } from "../industries/hospitality/workflows/finance-admin/add-comps/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/hospitality/workflows/finance-admin/add-comps/workflow.json", "utf8")) as WorkflowRecord;
type Hit = { method: string; path: string; params: URLSearchParams };
let hits: Hit[] = [];
let endless = false;

const P1 = { id: "PAY1", order_id: "ORD1", created_at: "2026-11-08T03:00:00Z", status: "COMPLETED", team_member_id: "TM1", location_id: "LOC1" };
const P2 = { id: "PAY2", order_id: "ORD2", created_at: "2026-11-08T04:00:00Z", status: "COMPLETED", location_id: "LOC1" };
const P3 = { id: "PAY3", order_id: "ORD3", created_at: "2026-11-08T04:30:00Z", status: "CANCELED", location_id: "LOC1" };
const P4 = { id: "PAY4", created_at: "2026-11-08T05:00:00Z", status: "COMPLETED", location_id: "LOC1" };
const ORDERS: Record<string, any> = {
  // A 100 percent staff comp on one line: not on the allowed list and over the threshold.
  ORD1: { id: "ORD1", created_at: "2026-11-08T03:00:00Z", location_id: "LOC1",
          discounts: [{ name: "Staff comp", percentage: "100", applied_money: { amount: 1800, currency: "AUD" }, scope: "LINE_ITEM" }] },
  // A 10 percent happy hour: on the allowed list and at the threshold, so not flagged.
  ORD2: { id: "ORD2", created_at: "2026-11-08T04:00:00Z", location_id: "LOC1",
          discounts: [{ name: "Happy hour", percentage: "10", applied_money: { amount: 250, currency: "AUD" }, scope: "ORDER" }] },
};

function fake() {
  hits = []; endless = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      hits.push({ method: m, path: p, params: u.searchParams });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v2/payments" && m === "GET") {
        if (endless) return json({ payments: [], cursor: "more" });
        return u.searchParams.get("cursor") === "c2" ? json({ payments: [P2, P3, P4] }) : json({ payments: [P1], cursor: "c2" });
      }
      const oid = /^\/v2\/orders\/([^/]+)$/.exec(p);
      if (oid && m === "GET") { const o = ORDERS[oid[1]]; return o ? json({ order: o }) : json({ errors: [] }, 404); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const SETTINGS: any = {
  business_name: "Test Hospitality", utc_offset_hours: 11, review_over_pct: 10, allowed_discounts: ["Happy hour"],
  venues: [{ name: "Bar", square_location_id: "LOC1" }],
};
const NOW = new Date("2026-11-09T06:00:00Z"); // 17:00 on 9 Nov in Sydney daylight time, so yesterday is 8 Nov

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SQUARE_ACCESS_TOKEN: "sq-test", KIT_ALLOW_WRITES: "0" });
});

test("every call the crons make is a read", async () => {
  const store = new MemoryStore();
  await watch(context(WF, SETTINGS, store, NOW, () => {}));
  await report(context(WF, SETTINGS, store, NOW, () => {}));
  assert.ok(hits.length > 0);
  for (const h of hits) assert.equal(h.method, "GET", `unexpected call ${h.method} ${h.path}`);
});

test("watch flags the 100 percent comp, passes the allowed discount, and skips cancelled and order-less payments", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await watch(context(WF, SETTINGS, store, NOW, () => {})), { venues: 1, read: 2, flagged: 1, skipped: 2 });
  const flag = await store.get<any>("flags", "ORD1");
  assert.ok(flag, "ORD1 is flagged");
  assert.ok(flag.reasons.some((r: string) => /100%, a comp/.test(r)));
  assert.ok(flag.reasons.some((r: string) => /not on the allowed list/.test(r)));
  assert.equal(flag.discount_dollars, 18);
  assert.equal(flag.team_member_id, "TM1");
  assert.equal(await store.get("flags", "ORD2"), undefined, "ORD2 is allowed and at the threshold");
  assert.equal(await store.get("orders", "ORD3"), undefined, "a cancelled payment is not read");
  assert.equal(hits.filter((h) => h.path.startsWith("/v2/orders/")).length, 2, "one order read per paid sale with an order");
});

test("a re-run reads no sale twice", async () => {
  const store = new MemoryStore();
  await watch(context(WF, SETTINGS, store, NOW, () => {}));
  const orderReads = hits.filter((h) => h.path.startsWith("/v2/orders/")).length;
  await watch(context(WF, SETTINGS, store, new Date(NOW.getTime() + 30 * 60e3), () => {}));
  assert.equal(hits.filter((h) => h.path.startsWith("/v2/orders/")).length, orderReads);
  assert.equal(Object.keys(await store.list("flags")).length, 1);
});

test("report counts yesterday's sales, discounts and flags for the venue", async () => {
  const store = new MemoryStore();
  await watch(context(WF, SETTINGS, store, NOW, () => {}));
  const day = await report(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(day.day, "2026-11-08");
  assert.deepEqual(day.venues, [{ venue: "Bar", orders: 2, discounted: 2, flagged: 1, discount_dollars: 20.5 }]);
});

test("the runtime refuses a write and any live operation for this workflow", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "square", op: "api.CreateOrder", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "square", op: "api.UpdateOrder", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "square", op: "api.RefundPayment", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0, "no call reached the network");
});

test("settings are checked before any call", async () => {
  const bad = { ...SETTINGS, venues: [{ name: "Bad", square_location_id: "LOC1; drop" }] };
  await assert.rejects(watch(context(WF, bad, new MemoryStore(), NOW, () => {})), /square_location_id/);
  assert.throws(() => venues({ ...SETTINGS, review_over_pct: 150 }), /review_over_pct/);
  assert.equal(hits.length, 0);
});

test("a busy window stops at the page limit, and the next run carries on from where it stopped", async () => {
  endless = true;
  const store = new MemoryStore();
  await watch(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(hits.filter((h) => h.path === "/v2/payments").length, 5, "five pages, then stop");
  const wm = await store.get<any>("watermark", "LOC1");
  assert.equal(wm.since, new Date(NOW.getTime() - 24 * 3600e3).toISOString(), "no sale read, so the window does not move on");
});
