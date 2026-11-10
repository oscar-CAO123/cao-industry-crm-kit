// Rostering workflow tests. Every request goes to a fake network: no test reaches a real Deputy account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { sync, draft, publish } from "../industries/all/workflows/people/rostering/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/people/rostering/workflow.json", "utf8")) as WorkflowRecord;
const S: any = {
  business_name: "Test Crew", deputy: { operational_unit: 7, draft_days_ahead: 14, publish_days_ahead: 7, late_grace_minutes: 5 },
  demand: [{ date: "2026-11-16", start: "2026-11-16T06:00:00+11:00", end: "2026-11-16T14:00:00+11:00", headcount: 2 }],
};
const NOW = new Date("2026-11-15T00:00:00Z");
const DAYSEC = (d: string) => Math.floor(Date.parse(d) / 1000);
const EMPLOYEES = [
  { Id: 11, FirstName: "Ari", LastName: "Lee", DisplayName: "Ari Lee", Active: true, TerminationDate: null },
  { Id: 12, FirstName: "Bo", LastName: "Ng", DisplayName: "Bo Ng", Active: true, TerminationDate: null },
  { Id: 13, FirstName: "Cy", LastName: "Diaz", DisplayName: "Cy Diaz", Active: true, TerminationDate: null },
  { Id: 14, FirstName: "Di", LastName: "Ray", DisplayName: "Di Ray", Active: false, TerminationDate: null },
];
const LEAVE = [{ Id: 1, Employee: 13, Start: "2026-11-16T00:00:00+11:00", End: "2026-11-17T00:00:00+11:00", Status: 1 }];
const TIMESHEETS = [
  { Id: 900, Employee: 11, StartTime: DAYSEC("2026-11-14T19:30:00Z"), Roster: 700, ValidationFlag: 0 },
];
const ROSTERS_FIXED = [
  { Id: 700, Employee: 11, StartTime: DAYSEC("2026-11-14T19:00:00Z"), EndTime: DAYSEC("2026-11-14T23:00:00Z"), Date: "2026-11-14T00:00:00+00:00", Published: true },
];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let created: any[] = [];

function fake() {
  hits = []; created = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/resource/Employee")) return json(EMPLOYEES);
      if (p.endsWith("/resource/EmployeeAvailability")) return json([]);
      if (p.endsWith("/resource/Leave")) return json(LEAVE);
      if (p.endsWith("/resource/RosterSwap")) return json([]);
      if (p.endsWith("/resource/Timesheet")) return json(TIMESHEETS);
      if (p.endsWith("/resource/Roster") && m === "GET") return json([...ROSTERS_FIXED, ...created]);
      if (p.endsWith("/resource/Roster") && m === "POST") {
        const rec = { Id: 500 + created.length, ...body };
        created.push(rec);
        return json(rec);
      }
      const upd = p.match(/\/resource\/Roster\/(\d+)$/);
      if (upd && m === "POST") return json({ Id: Number(upd[1]), Published: true });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const publishes = () => hits.filter((h) => /\/resource\/Roster\/\d+$/.test(h.path) && h.method === "POST");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { DEPUTY_ACCESS_TOKEN: "tok", DEPUTY_SUBDOMAIN: "acme", DEPUTY_REGION: "au", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot publish and a cron cannot queue a draft operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "deputy", op: "deputy-v1-resource-api.updateRoster", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "deputy", op: "deputy-v1-resource-api.createRoster", summary: "x" }), /not a live operation/);
});

test("draft: private shifts for the two people who are free, never the one on leave or the inactive one, never published", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await draft(ctx), { drafted: 2, shortfalls: 0 });
  assert.deepEqual(created.map((c) => c.Employee), [11, 12]);
  for (const c of created) assert.equal(c.Published, false);
  assert.equal(publishes().length, 0, "a cron never publishes");
  assert.equal(created[0].StartTime, DAYSEC("2026-11-16T06:00:00+11:00"));
});

test("draft: a re-run never drafts the same block twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await draft(ctx);
  const before = created.length; // what Deputy now holds after the first run
  assert.deepEqual(await draft(context(WF, S, store, NOW, () => {})), { drafted: 0, shortfalls: 0 });
  assert.equal(created.length, before);
});

test("draft: a block that cannot be filled is recorded as a shortfall with its reason", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, { ...S, demand: [{ ...S.demand[0], headcount: 4 }] }, store, NOW, () => {});
  assert.deepEqual(await draft(ctx), { drafted: 2, shortfalls: 1 });
  const [sf] = Object.values(await store.list<any>("shortfalls"));
  assert.equal(sf.wanted, 4);
  assert.match(sf.reason, /2 short/);
});

test("publish: each unpublished draft is queued once, never run by the cron; re-runs do not queue twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await draft(ctx);
  assert.deepEqual(await publish(ctx), { waiting: 2 });
  assert.equal(publishes().length, 0, "queued, not sent");
  await publish(context(WF, S, store, NOW, () => {}));
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 2, "re-runs never queue twice");
  assert.deepEqual(approvals[0].acts[0].input, { params: { id: Number(approvals[0].acts[0].input!.params!.id) }, body: { Published: true } });
});

test("approval publishes one shift: Published true on that roster record, and only then", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await draft(ctx); await publish(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals")).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(publishes().length, 0);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(publishes().length, 1);
  assert.deepEqual(publishes()[0].body, { Published: true });
  assert.match(publishes()[0].path, /\/resource\/Roster\/\d+$/);
});

test("sync: reads only, stores rosters and swaps, flags a late clock-in", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await sync(ctx), { rosters: 1, flagged: 1 });
  assert.equal(writes().length, 0, "sync writes nothing to Deputy");
  const flags = Object.values(await store.list<any>("flags"));
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /after the rostered start/);
});

test("the business's own records are never sent: no send or publish path exists in any cron", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await sync(ctx); await draft(ctx); await publish(ctx);
  assert.equal(hits.filter((h) => /send|message|sms|email/i.test(h.path)).length, 0);
  assert.equal(publishes().length, 0);
});
