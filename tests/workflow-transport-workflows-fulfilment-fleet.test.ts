// Fleet service planner tests. Every request goes to a fake network: no test reaches a real Trackunit account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { status, plan } from "../industries/transport/workflows/fulfilment/fleet/index.ts";

const WF = JSON.parse(fs.readFileSync("industries/transport/workflows/fulfilment/fleet/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const SETTINGS: any = { business_name: "Test Transport", assets: ["veh-001", "veh-002"], system_of_measurement: "metric" };

type Hit = { method: string; path: string; query: string | null; body: any };
let hits: Hit[] = [];
let statuses: Record<string, { plannedServiceId: string; servicePlanId: string; status: string }[]> = {};
let issues: Record<string, number> = {};

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams.get("assetId"), body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/api/service-management/v2/plans/assignments/service-status" && m === "GET")
        return json({ plannedServiceStatuses: statuses[u.searchParams.get("assetId")!] ?? [] });
      const issuesMatch = /^\/api\/device-health-issues\/v1\/assets\/([^/]+)\/issues$/.exec(p);
      if (issuesMatch && m === "GET") return json({ content: [], totalElements: issues[issuesMatch[1]] ?? 0 });
      if (p === "/api/service-management/booking" && m === "POST") return json({ plannedServiceId: body?.plannedServiceId });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const bookings = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/booking"));

beforeEach(() => {
  fake();
  statuses = {
    "veh-001": [
      { plannedServiceId: "ps-100", servicePlanId: "sp-1", status: "OVERDUE" },
      { plannedServiceId: "ps-101", servicePlanId: "sp-1", status: "PLANNED" },
    ],
    "veh-002": [{ plannedServiceId: "ps-200", servicePlanId: "sp-2", status: "UPCOMING" }],
  };
  issues = { "veh-001": 2 };
  Object.assign(process.env, { TRACKUNIT_ACCESS_TOKEN: "t".repeat(40), KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation and cannot queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "trackunit", op: "service-management.MakeBooking", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "trackunit", op: "device-health-issues.getIssuesByAsset", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("status: reads due services and open issues, never writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await status(ctx), { vehicles: 2, due: 2, open_issues: 2 });
  assert.equal(writes().length, 0, "nothing written to Trackunit by the status cron");
  const snap = await store.get<any>("fleet", "veh-001");
  assert.deepEqual(snap.due.map((d: any) => d.plannedServiceId), ["ps-100"], "PLANNED is not due");
});

test("plan: queues one booking per due service for approval, and never books", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await plan(ctx), { approvals: 2 });
  assert.equal(bookings().length, 0, "no booking reaches the workshop from a cron");
  const queued = Object.values(await store.list<Approval>("approvals"));
  assert.equal(queued.length, 2);
  assert.ok(queued.every((a) => a.status === "pending"));
  assert.deepEqual(queued.map((a) => a.acts[0].input).map((i) => i!.body).map((b) => [b.assetId, b.plannedServiceId]).sort(),
    [["veh-001", "ps-100"], ["veh-002", "ps-200"]]);
});

test("plan: re-runs never double-queue", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await plan(ctx);
  await plan(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 2);
  assert.equal(bookings().length, 0);
});

test("approval runs the booking once, with the ids the cron queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await plan(ctx);
  const ap = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].input!.body.plannedServiceId === "ps-100")!;
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(bookings().length, 1);
  assert.deepEqual(bookings()[0].body, { assetId: "veh-001", plannedServiceId: "ps-100" });
});

test("a vehicle id that is not safe is refused before any call", async () => {
  const ctx = context(WF, { ...SETTINGS, assets: ["../etc"] }, new MemoryStore(), NOW, () => {});
  await assert.rejects(status(ctx), /bad vehicle id/);
  await assert.rejects(plan(ctx), /bad vehicle id/);
  assert.equal(hits.length, 0);
});

test("an empty vehicle list is refused", async () => {
  const ctx = context(WF, { ...SETTINGS, assets: [] }, new MemoryStore(), NOW, () => {});
  await assert.rejects(status(ctx), /lists no vehicles/);
});
