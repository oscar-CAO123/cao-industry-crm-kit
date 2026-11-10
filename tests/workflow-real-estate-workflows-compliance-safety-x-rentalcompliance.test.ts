// Rental compliance workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { watch, draft, booking } from "../industries/real-estate/workflows/compliance-safety/x-rentalcompliance/index.ts";

const DIR = "industries/real-estate/workflows/compliance-safety/x-rentalcompliance";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const BASE = "/api/v1.3";
const NOW = new Date("2026-11-08T00:00:00Z");
const S: any = { business_name: "Test Property", user_id: 42, stale_days: 3, task_start_days: 1 };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let openJobs: any[] = [];

function fake() {
  hits = [];
  openJobs = [
    { id: 1001, summary: "Smoke alarm battery", description: "Chirping in hallway", status: "New", inserted: "2026-11-01T09:00:00Z" },
    { id: 1002, summary: "Hot water", description: "No hot water", status: "New", inserted: "2026-11-07T09:00:00Z" },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === `${BASE}/maintenance` && m === "GET") return json({ items: openJobs, totalItems: openJobs.length, totalPages: 1, urls: {} });
      if (p === `${BASE}/tasks` && m === "GET") return json({ items: [], totalItems: 0, totalPages: 1, urls: {} });
      if (p === `${BASE}/contacts/currentTenants` && m === "GET") return json({ items: [{ contact: { id: 9 }, tenancy: { id: 7 } }], totalItems: 1, totalPages: 1, urls: {} });
      if (p === `${BASE}/tasks` && m === "POST") return json({ id: 555 });
      if (/^\/api\/v1\.3\/properties\/\d+\/lease\/\d+\/maintenance$/.test(p) && m === "POST") return json({ id: 777 });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { VAULTRE_ACCESS_TOKEN: "tok", VAULTRE_API_KEY: "key", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a live operation cannot run as a draft", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "vaultre", op: "addMaintenance", summary: "x" }), /not a draft operation/);
});

test("watch reads open work and writes nothing to VaultRE", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await watch(context(WF, S, store, NOW, () => {})), { open_maintenance: 2, open_tasks: 0, current_tenants: 1 });
  assert.equal(writes().length, 0);
  const snap = await store.get<any>("snapshot", "latest");
  assert.deepEqual(snap.maintenance_ids, [1001, 1002]);
});

test("draft: one follow-up task per stale job, never repeated on a re-run, and nothing sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await draft(ctx), { drafted: 1, skipped: 1 });
  const tasks = hits.filter((h) => h.path === `${BASE}/tasks` && h.method === "POST");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].body.user.id, 42);
  assert.match(tasks[0].body.subject, /1001/);
  assert.equal(writes().some((h) => /maintenance$/.test(h.path)), false, "no maintenance job created by a cron");
  assert.deepEqual(await draft(ctx), { drafted: 0, skipped: 2 });
  assert.equal(writes().filter((h) => h.path === `${BASE}/tasks`).length, 1, "re-runs never add a second task");
});

test("draft is refused before the network when writes are not allowed", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  await assert.rejects(draft(context(WF, S, new MemoryStore(), NOW, () => {})), WriteBlocked);
  assert.equal(writes().length, 0);
});

test("a booking is queued for approval, never sent by the cron, and queued only once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("bookings", "b1", { key: "b1", property_id: 10, lease_life_id: 20, tenancy_id: 7, requested_by_id: 42,
    summary: "Gas hot water service check", status: "new" });
  assert.deepEqual(await booking(ctx), { queued: 1 });
  assert.equal(writes().length, 0, "the cron sends nothing");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.deepEqual(await booking(ctx), { queued: 0 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "re-runs never double-queue");
});

test("an approved booking creates the maintenance job on the lease life", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("bookings", "b1", { key: "b1", property_id: 10, lease_life_id: 20, tenancy_id: 7, requested_by_id: 42,
    summary: "Gas hot water service check", status: "new" });
  await booking(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const job = writes().find((h) => h.path === `${BASE}/properties/10/lease/20/maintenance`)!;
  assert.equal(job.method, "POST");
  assert.equal(job.body.tenancy.id, 7);
  assert.equal(job.body.requestedBy.id, 42);
});

test("ids that would reach a path or body are refused before the network", async () => {
  const store = new MemoryStore();
  await store.put("bookings", "bad", { key: "bad", property_id: "10/../x", lease_life_id: 20, tenancy_id: 7, requested_by_id: 42,
    summary: "x", status: "new" });
  await assert.rejects(booking(context(WF, S, store, NOW, () => {})), /positive whole number/);
  assert.equal(writes().length, 0);
});
