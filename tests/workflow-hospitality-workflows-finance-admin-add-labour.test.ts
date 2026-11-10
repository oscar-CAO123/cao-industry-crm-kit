// Labour alerts workflow tests. Every request goes to a fake network: no test reaches a real Deputy account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { pull, check, venues } from "../industries/hospitality/workflows/finance-admin/add-labour/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/hospitality/workflows/finance-admin/add-labour/workflow.json", "utf8")) as WorkflowRecord;
type Hit = { method: string; path: string; body: any; params: URLSearchParams };
let hits: Hit[] = [];

// Timesheets per area: [cost, discarded, leave]. Area 12 has a discarded row and a leave row, which must not count.
const TIMESHEETS: Record<number, [number, boolean, boolean][]> = {
  12: [[180.5, false, false], [40, true, false], [60, false, true]],
  14: [[400, false, false]],
  15: [[30, false, false]],
  99: Array.from({ length: 500 }, () => [1, false, false] as [number, boolean, boolean]),
};
// Sales rows per area. Area 13 holds a stray row that must not be counted for area 12.
const SALES: { area: number; type: string; value: number | string }[] = [
  { area: 12, type: "Sales", value: 600 }, { area: 12, type: "Sales", value: "400.25" },
  { area: 13, type: "Sales", value: 9999 }, { area: 14, type: "Sales", value: 1000 }, { area: 15, type: "Sales", value: 50 },
];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, params: u.searchParams });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/resource/Timesheet/QUERY") && m === "POST") {
        const area = Number(body?.search?.s2?.data);
        const rows = (TIMESHEETS[area] ?? []).map(([cost, discarded, leave], i) => ({ Id: i + 1, Date: body.search.s1.data, OperationalUnit: area, Cost: cost, Discarded: discarded, IsLeave: leave }));
        return json(rows);
      }
      if (p.endsWith("/v2/metrics/raw") && m === "GET") {
        const area = Number(u.searchParams.get("areas"));
        return json({ success: true, data: SALES.filter((s) => s.area === area || area === 0).map((s) => ({ ...s, timestamp: 1, employee: 0, reference: "" })) });
      }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const SETTINGS: any = {
  business_name: "Test Hospitality", utc_offset_hours: 11, min_sales: 200,
  venues: [
    { name: "Bar", deputy_area: 12, labour_target_pct: 30 },
    { name: "Function Room", deputy_area: 14, labour_target_pct: 25 },
    { name: "Thin Day", deputy_area: 15, labour_target_pct: 25 },
  ],
};
const NOW = new Date("2026-11-09T06:00:00Z"); // 17:00 on 9 Nov in Sydney daylight time
const DAY = "2026-11-09";

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { DEPUTY_SUBDOMAIN: "testco", DEPUTY_REGION: "au", DEPUTY_ACCESS_TOKEN: "tok", KIT_ALLOW_WRITES: "0" });
});

test("every Deputy call the crons make is a read", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SETTINGS, store, NOW, () => {}));
  await check(context(WF, SETTINGS, store, NOW, () => {}));
  assert.ok(hits.length > 0);
  for (const h of hits) {
    const isTimesheetSearch = h.method === "POST" && h.path.endsWith("/resource/Timesheet/QUERY");
    const isSalesRead = h.method === "GET" && h.path.endsWith("/v2/metrics/raw");
    assert.ok(isTimesheetSearch || isSalesRead, `unexpected call ${h.method} ${h.path}`);
  }
});

test("pull and check: only the venue over target is open, thin sales wait, a stray area row is ignored", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await pull(context(WF, SETTINGS, store, NOW, () => {})), { venues: 3, day: DAY });
  const snap = await store.get<any>("labour", `area-12:${DAY}`);
  assert.equal(snap.labour_cost, 180.5, "discarded and leave rows are left out of labour");
  assert.equal(snap.sales, 1000.25, "only area 12 sales, text values read as numbers");
  await check(context(WF, SETTINGS, store, NOW, () => {}));
  const bar = await store.get<any>("alerts", `area-12:${DAY}`);
  assert.equal(bar.status, "ok");
  assert.equal(bar.labour_pct, 18);
  const room = await store.get<any>("alerts", `area-14:${DAY}`);
  assert.equal(room.status, "open");
  assert.equal(room.labour_pct, 40);
  assert.ok(room.raised);
  assert.equal((await store.get<any>("alerts", `area-15:${DAY}`)).status, "waiting-for-data");
});

test("re-runs keep one alert per venue per day and keep the first raised time", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SETTINGS, store, NOW, () => {}));
  await check(context(WF, SETTINGS, store, NOW, () => {}));
  const first = (await store.get<any>("alerts", `area-14:${DAY}`)).raised;
  await pull(context(WF, SETTINGS, store, new Date(NOW.getTime() + 30 * 60e3), () => {}));
  await check(context(WF, SETTINGS, store, new Date(NOW.getTime() + 60 * 60e3), () => {}));
  assert.equal(Object.keys(await store.list("alerts")).length, 3);
  assert.equal((await store.get<any>("alerts", `area-14:${DAY}`)).raised, first);
});

test("the runtime refuses a write and a live operation for this workflow", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "deputy", op: "deputy-v2-api.LaborModelV2Controller_createLaborModelRule", input: { params: { locationId: 12 }, body: {} }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "deputy", op: "deputy.Discardaroster", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "deputy", op: "deputy.Publisharoster", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0, "no call reached the network");
});

test("settings are checked before any call", async () => {
  const bad = { ...SETTINGS, venues: [{ name: "Bad", deputy_area: "12; drop", labour_target_pct: 30 }] };
  await assert.rejects(pull(context(WF, bad, new MemoryStore(), NOW, () => {})), /whole number/);
  const badTarget = { ...SETTINGS, venues: [{ name: "Bad", deputy_area: 12, labour_target_pct: 0 }] };
  assert.throws(() => venues(badTarget), /above 0/);
  assert.equal(hits.length, 0);
});

test("a full page of timesheets is refused rather than read as a short labour figure", async () => {
  const big = { ...SETTINGS, venues: [{ name: "Big", deputy_area: 99, labour_target_pct: 30 }] };
  await assert.rejects(pull(context(WF, big, new MemoryStore(), NOW, () => {})), /more than one page/);
});

test("no approval exists to run: an unknown approval id is refused", async () => {
  await assert.rejects(approve(WF, new MemoryStore(), "hospitality-labour-missing", "owner"), /no approval/);
});
