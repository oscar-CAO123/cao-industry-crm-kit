// Maintenance workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/manufacturing/workflows/fulfilment/x-maintenance/index.ts";

const WF = JSON.parse(fs.readFileSync("industries/manufacturing/workflows/fulfilment/x-maintenance/workflow.json", "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", CO = "87654321-4321-4321-8321-210987654321", ASSET = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let jobStatus = "Work Order";
let checklists: { job_uuid: string; name: string; section_name: string }[] = [];
let companyEmail = "sam@example.com";

function fake() {
  hits = []; jobStatus = "Work Order"; checklists = []; companyEmail = "sam@example.com";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname, filter = u.searchParams.get("$filter") ?? "";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: filter, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (p.endsWith("/job.json") && m === "GET") {
        if (filter.includes("'Completed'")) return json([{ uuid: JOB, active: 1, status: "Completed", job_description: "Press 4 hydraulic seal", edit_date: "2026-11-08 16:00:00" }]);
        return json(filter.includes(`'${jobStatus}'`) ? [{ uuid: JOB, active: 1, status: jobStatus, job_description: "Hydraulic press 4 leaking oil at the ram seal", company_uuid: CO, date: "2026-11-08" }] : []);
      }
      if (p.endsWith("/asset.json")) return json([{ uuid: ASSET, active: 1, name: "Hydraulic press 4", asset_code: "HP-04" }]);
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: companyEmail, is_primary_contact: "1" }]);
      if (p.endsWith("/jobchecklist.json") && m === "GET") return json(checklists.filter((c) => filter.includes(c.job_uuid)).map((c) => ({ ...c, active: 1 })));
      if (p.endsWith("/jobchecklist.json") && m === "POST") { checklists.push({ job_uuid: body.job_uuid, name: body.name, section_name: body.section_name }); return json({ errorCode: 0 }, { "x-record-uuid": "c-" + checklists.length }); }
      if (p.endsWith("/jobmaterial.json")) return json([{ active: 1, name: "Ram seal kit", quantity: "1", price: "180" }]);
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/platform_service_email"));
const writes = () => hits.filter((h) => h.method !== "GET");
const S: any = {
  business_name: "Test Engineering", job_status_open: "Work Order", job_status_done: "Completed",
  lockout_steps: ["Stop the press at its panel", "Lock out and tag the isolator", "Release stored pressure to zero"],
};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot send directly and cannot queue a draft operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createJobChecklists", summary: "x" }), /not a live operation/);
});

test("work order to booking note: checklist drafted, email queued, nothing sent until approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await CRONS.intake(ctx), { added: 1 });
  const [req] = Object.values(await store.list<any>("requests"));
  assert.equal(req.asset, "Hydraulic press 4", "machine matched by name in the job text");

  assert.deepEqual(await CRONS.draft(ctx), { drafted: 1, steps: 3 });
  assert.deepEqual(checklists.map((c) => c.name), S.lockout_steps, "checklist in the settings order");
  assert.ok(checklists.every((c) => c.section_name === "Lockout and isolation" && c.job_uuid === JOB));

  assert.deepEqual(await CRONS.notify(ctx), { queued: 1, no_contact: 0 });
  assert.equal(sends().length, 0, "no cron sends an email");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].acts[0].op, "messaging-api.send_email");
  assert.equal(pending[0].acts[0].input?.body.to, "sam@example.com");
});

test("re-runs never repeat a checklist step or queue a second booking note", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await CRONS.intake(ctx); await CRONS.draft(ctx); await CRONS.notify(ctx);
  await CRONS.intake(ctx); await CRONS.draft(ctx); await CRONS.notify(ctx);
  assert.equal(checklists.length, 3);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
  assert.equal(sends().length, 0);
});

test("approval sends the booking note once, to the approved address", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await CRONS.intake(ctx); await CRONS.draft(ctx); await CRONS.notify(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].body.to, "sam@example.com");
  assert.equal(sends()[0].body.regardingJobUUID, JOB);
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
});

test("a request with no email is recorded and nothing is queued", async () => {
  companyEmail = "not-an-email";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await CRONS.intake(ctx); await CRONS.draft(ctx);
  assert.deepEqual(await CRONS.notify(ctx), { queued: 0, no_contact: 1 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("close-out reads completed jobs and their parts, with no writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await CRONS["close-out"](ctx), { added: 1 });
  const [closed] = Object.values(await store.list<any>("closed"));
  assert.deepEqual(closed.parts, [{ name: "Ram seal kit", quantity: "1", price: "180" }]);
  assert.equal(writes().length, 0);
});

test("a status name that could break out of the filter is refused before any call", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S, job_status_open: "Work Order' or 1 eq 1" }, store, NOW, () => {});
  await assert.rejects(CRONS.intake(ctx), /bad job status/);
  assert.equal(hits.length, 0);
});

test("the SDK gate still blocks the checklist write when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await CRONS.intake(ctx);
  await assert.rejects(CRONS.draft(ctx), WriteBlocked);
  assert.equal(checklists.length, 0);
});
