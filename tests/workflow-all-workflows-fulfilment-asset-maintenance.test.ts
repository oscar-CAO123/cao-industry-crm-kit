// Asset-maintenance workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { register, serviceDue, defects } from "../industries/all/workflows/fulfilment/asset-maintenance/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/fulfilment/asset-maintenance/workflow.json", "utf8")) as WorkflowRecord;
const SETTINGS: any = { family: "plant-and-vehicle-servicing", business_name: "Test Civil Hire", depot_address: "1 Depot Road",
  reminder_email: "fleet@example.com.au", service_window_days: 14, max_assets: 50 };
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; body: any; query: URLSearchParams };
let hits: Hit[] = [];
let jobN = 0;

function fake() {
  hits = []; jobN = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, query: u.searchParams });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      // Trackunit (read)
      if (p.endsWith("/v2/assets") && m === "GET") return json({ content: [
        { id: "ASSET-1", name: "Excavator 320", type: "Excavator", serialNumber: "CAT320", hidden: false },
        { id: "ASSET-2", name: "Hidden ute", hidden: true } ], number: 0, totalElements: 2 });
      if (p.endsWith("/v2/plans/assignments/service-status") && m === "GET") {
        if (u.searchParams.get("assetId") === "ASSET-1") return json({ plannedServiceStatuses: [
          { plannedServiceId: "PS-1", servicePlanId: "SP-1", name: "250 hour service", status: "OVERDUE", booked: false },
          { plannedServiceId: "PS-2", servicePlanId: "SP-1", name: "Booked oil change", status: "UPCOMING", booked: true, predictedServiceTime: "2026-11-10T00:00:00Z" } ] });
        return json({ plannedServiceStatuses: [] });
      }
      if (p.endsWith("/inspection-responses") && m === "GET") return json({ content: [
        { id: "IR-1", assetId: "ASSET-1", status: "FAILED_CRITICAL", endTime: "2026-11-08T00:00:00Z",
          answers: [ { answer: "Hydraulic hose leaking", criticality: "FAILED_CRITICAL", comment: "Under the boom" }, { answer: "Mirror clean", criticality: "PASSED" } ] },
        { id: "IR-2", assetId: "ASSET-1", status: "PASSED", answers: [ { answer: "Mirror clean", criticality: "PASSED" } ] } ], number: 0, totalElements: 2 });
      // ServiceM8 (writes allowed only as drafts, and one live email)
      if (p.endsWith("/job.json") && m === "POST") { jobN++; return json({ errorCode: 0 }, { "x-record-uuid": `00000000-0000-4000-8000-00000000000${jobN}` }); }
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0, messageID: "M1" });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const jobPosts = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/job.json"));
const emails = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/platform_service_email"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { TRACKUNIT_ACCESS_TOKEN: "tu", SERVICEM8_API_KEY: "s8", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", KIT_ALLOW_WRITES: "1" });
});

test("register: only visible Trackunit assets are kept, and nothing is written", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await register(context(WF, SETTINGS, store, NOW, () => {})), { added: 1 });
  const assets = await store.list<any>("assets");
  assert.deepEqual(Object.values(assets).map((a) => a.id), ["ASSET-1"]);
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "reads only");
});

test("service-due: one Work Order job for the overdue plan item, one reminder queued, nothing sent until approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await register(ctx);
  assert.deepEqual(await serviceDue(ctx), { jobs: 1, queued: 1 });
  assert.equal(jobPosts().length, 1);
  assert.equal(jobPosts()[0].body.status, "Work Order");
  assert.match(jobPosts()[0].body.job_description, /250 hour service/);
  assert.doesNotMatch(jobPosts()[0].body.job_description, /Booked oil change/, "items booked in Trackunit are skipped");
  assert.equal(emails().length, 0, "a cron never sends");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["messaging-api.send_email"]);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(emails().length, 1);
  assert.equal(emails()[0].body.to, "fleet@example.com.au");
  assert.equal(emails()[0].body.regardingJobUUID, "00000000-0000-4000-8000-000000000001");
});

test("re-runs never create a second job or queue a second reminder", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await register(ctx);
  await serviceDue(ctx);
  assert.deepEqual(await serviceDue(context(WF, SETTINGS, store, NOW, () => {})), { jobs: 0, queued: 1 });
  assert.equal(jobPosts().length, 1, "no second job");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "no second reminder");
});

test("defects: a failed critical check becomes one job, passed checks do not, and re-runs do not repeat it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await register(ctx);
  assert.deepEqual(await defects(ctx), { jobs: 1 });
  assert.equal(jobPosts().length, 1);
  assert.match(jobPosts()[0].body.job_description, /CRITICAL defect: Excavator 320/);
  assert.match(jobPosts()[0].body.job_description, /Hydraulic hose leaking \(Under the boom\)/);
  assert.doesNotMatch(jobPosts()[0].body.job_description, /Mirror clean/);
  assert.deepEqual(await defects(context(WF, SETTINGS, store, NOW, () => {})), { jobs: 0 });
  assert.equal(jobPosts().length, 1);
});

test("runtime: a cron cannot draft a live operation or queue a draft operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createJobs", summary: "x" }), /not a live operation/);
  assert.equal(emails().length, 0);
});

test("bad settings stop the run before any call is made", async () => {
  const bad = { ...SETTINGS, reminder_email: "not-an-email" };
  await assert.rejects(serviceDue(context(WF, bad, new MemoryStore(), NOW, () => {})), /reminder_email/);
  assert.equal(hits.length, 0);
});
